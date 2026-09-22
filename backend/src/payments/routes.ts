import express, { type Router } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { SendDeps } from '../notifications/send.js';
import { depositView, handleReturn, startCheckout } from './deposits.js';
import { paymentProvider } from './registry.js';
import { SimulatedProvider } from './simulated.js';

/**
 * Two surfaces, both anonymous.
 *
 * `/public/deposits/:token` is the payment page's data. The token is the only
 * credential — it arrived in the customer's WhatsApp chat or their browser,
 * and whoever holds it may pay. Paying someone else's deposit harms nobody,
 * so nothing more is needed; reading the page reveals a service name and a
 * time, which is why the token is random rather than the booking id.
 *
 * `/payments/:provider/return` is where the gateway sends the customer's
 * browser back. Its body is untrusted until the provider's signature check
 * says otherwise — see PaymentProvider.parseReturn.
 */
export function createDepositRouter(deps: SendDeps): { publicRouter: Router; gatewayRouter: Router } {
  const publicRouter = express.Router();

  publicRouter.get('/deposits/:token', async (req, res) => {
    const view = await depositView(String(req.params.token));
    if (!view) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(view);
  });

  publicRouter.post('/deposits/:token/checkout', async (req, res) => {
    const result = await startCheckout(String(req.params.token));
    if (!result.ok) {
      res
        .status(result.reason === 'not_found' ? 404 : 409)
        .json({ error: result.reason === 'not_found' ? 'not found' : 'this deposit can no longer be paid', reason: result.reason });
      return;
    }
    res.json(result.redirect);
  });

  const gatewayRouter = express.Router();

  // JazzCash posts form-encoded; the simulator's buttons do too.
  gatewayRouter.post(
    '/:provider/return',
    express.urlencoded({ extended: false, limit: '32kb' }),
    async (req, res) => {
      if (req.params.provider !== paymentProvider().name) {
        res.status(404).send('Unknown payment provider');
        return;
      }

      try {
        const token = await handleReturn(deps, (req.body ?? {}) as Record<string, string>);
        if (!token) {
          res.status(400).send('This payment response could not be verified.');
          return;
        }
        // 303: the browser follows with a GET, so a refresh of the result page
        // never re-posts the gateway's response.
        res.redirect(303, `${env.WEB_URL}/pay/${encodeURIComponent(token)}`);
      } catch (err) {
        logger.error({ err }, 'payment return failed');
        res.status(500).send('Something went wrong recording your payment. It has not been lost — please contact the business.');
      }
    },
  );

  /**
   * The simulator's "gateway" page. Only exists when the simulated provider is
   * active, which env.ts guarantees is never production. Anyone who reaches it
   * can approve a simulated payment — that is what it is for.
   */
  gatewayRouter.get('/simulated/checkout', (req, res) => {
    const provider = paymentProvider();
    if (!(provider instanceof SimulatedProvider)) {
      res.status(404).end();
      return;
    }

    const txnRef = String(req.query.txnRef ?? '');
    const amount = Number(req.query.amountMinor ?? 0) / 100;
    const description = String(req.query.description ?? '');
    const button = (outcome: 'paid' | 'failed', label: string, style: string) => {
      const body = provider.returnBody(txnRef, outcome);
      const inputs = Object.entries(body)
        .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
        .join('');
      return `<form method="post" action="/payments/simulated/return">${inputs}<button style="${style}">${label}</button></form>`;
    };

    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulated payment</title>
<style>body{font:16px system-ui;margin:0;background:#f5f5f5;color:#0d0d0d}main{max-width:380px;margin:48px auto;padding:24px;background:#fff;border-radius:16px;border:1px solid #e5e5e5}
.tag{display:inline-block;font-size:12px;font-weight:600;background:#fff4d6;color:#8a5a00;padding:4px 8px;border-radius:6px}
h1{font-size:20px;margin:16px 0 4px}p{color:#737373;margin:0 0 24px}button{width:100%;padding:14px;border-radius:999px;font:600 16px system-ui;cursor:pointer;margin-top:8px}</style></head>
<body><main><span class="tag">SANDBOX — no real money</span>
<h1>Rs ${escape(amount.toLocaleString('en-PK'))}</h1><p>${escape(description)}<br>Ref ${escape(txnRef)}</p>
${button('paid', 'Pay', 'background:#0d0d0d;color:#fff;border:0')}
${button('failed', 'Decline', 'background:#fff;color:#0d0d0d;border:1px solid #e5e5e5')}
</main></body></html>`);
  });

  return { publicRouter, gatewayRouter };
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
