import type { RequestHandler } from 'express';
import { env } from '../config/env.js';

/**
 * Response headers every route gets — milestone 4.2.
 *
 * The review that added this found none of them set. That mattered less than it
 * looks for the JSON API, where there is no document for a browser to attack,
 * and quite a lot for the two surfaces that are not JSON: the owner dashboard
 * calls this API from a real page, and the simulated payment gateway serves HTML
 * of its own.
 *
 * Hand-written rather than `helmet`, because the useful subset is this short and
 * a dependency in the request path of every route is a dependency to keep
 * patched forever. What helmet would add beyond this is mostly headers for
 * features this API does not use.
 */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  /**
   * The one with teeth for an API. Without it a browser may sniff a JSON body
   * as HTML and run script that a client reflected into it — the reason every
   * error message here is data rather than markup is only half the defence.
   */
  res.setHeader('X-Content-Type-Options', 'nosniff');

  /**
   * Nothing this server returns is meant to be framed. The dashboard is on the
   * web origin, not this one, so denying outright costs nothing and forecloses
   * clickjacking against anything that ever does return a page — the payment
   * simulator included.
   */
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

  /**
   * URLs here carry credentials in the path — a deposit token, a customer's
   * `/me` token. A referrer on any outbound navigation hands one to a third
   * party. The `/me` router sets this for itself too; this is the floor under
   * everything else.
   */
  res.setHeader('Referrer-Policy', 'no-referrer');

  /**
   * Only in production, and only because it is a promise that cannot be taken
   * back: a browser that sees this refuses plain HTTP to the host for a year.
   * Sending it from a development server would lock `http://localhost` out of
   * every other project on the machine.
   */
  if (env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  /**
   * Express advertises itself by default. Not a vulnerability, but it tells a
   * scanner which CVE list to start from, and removing it is free.
   */
  res.removeHeader('X-Powered-By');

  next();
};
