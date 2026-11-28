import Link from 'next/link';
import { fetchApi } from '@/lib/api-client';
import { SITE_URL } from '@/lib/site';
import { formatPhone, profileLink } from '@/lib/grow';
import { QrCode } from '@/components/dashboard/grow/QrCode';
import { PrintButton } from '@/components/dashboard/grow/PrintButton';

/**
 * The counter poster (SPEC §10, §14.2). One A4 sheet, one job: get a customer
 * standing in the shop to send the business's WhatsApp number a first message.
 *
 * That first message is the point, not a side effect. WhatsApp can silently drop
 * a business's first message to someone who has never messaged it (spike finding
 * #3/#4), so a customer who scans this becomes someone every later reminder and
 * confirmation actually reaches. The web link is the fallback for a business that
 * has not connected a number yet.
 *
 * Black on white and big: it has to survive an office printer, and be scanned
 * from arm's length by someone's cousin's phone.
 */

interface OwnerBusiness {
  name: string;
  slug: string;
  published: boolean;
  profile?: { tagline?: string; themeColor?: string | null };
}

export default async function PosterPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { businessId } = await params;
  const { kind: kindParam } = await searchParams;

  const [business, invite] = await Promise.all([
    fetchApi<OwnerBusiness>(`/businesses/${businessId}`).catch(() => null),
    fetchApi<{ phone: string; link: string }>(`/businesses/${businessId}/invite`).catch(() => null),
  ]);
  const back = `/dashboard/${businessId}/grow`;

  if (!business) {
    return <p className="py-12 text-center text-muted">Could not load your business. Please try refreshing.</p>;
  }

  const canWhatsapp = Boolean(invite);
  const canWeb = business.published;
  const kind: 'whatsapp' | 'web' | null =
    kindParam === 'web' && canWeb ? 'web' : kindParam === 'whatsapp' && canWhatsapp ? 'whatsapp' : canWhatsapp ? 'whatsapp' : canWeb ? 'web' : null;

  if (!kind) {
    return (
      <div className="mx-auto max-w-[560px] py-12 text-center">
        <h1 className="text-[22px] font-bold text-ink">Nothing to point the poster at yet</h1>
        <p className="mt-2 text-[15px] text-muted">
          Connect your WhatsApp number in the app, or publish your listing in Settings.
        </p>
        <Link href={back} className="mt-6 inline-block font-semibold text-brand hover:underline">
          Back to Grow
        </Link>
      </div>
    );
  }

  const accent = business.profile?.themeColor ?? '#6950f3';
  const webLink = profileLink(business.slug, 'qr');
  const shortWeb = `${SITE_URL.replace(/^https?:\/\//, '')}/${business.slug}`;

  return (
    <div className="py-2 print:py-0">
      {/* A4, no browser margins: the sheet below is laid out to the edge itself.
          It is 296mm, not 297 — a sheet exactly one page tall spills a blank
          second page on printers that round a fraction of a pixel up. */}
      <style>{`@page { size: A4; margin: 0; } @media print { html, body { background: #fff; } }`}</style>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 print:hidden">
        <div>
          <Link href={back} className="text-[14px] font-semibold text-brand hover:underline">
            ← Grow
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink lowercase font-display">qr poster</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canWhatsapp && canWeb && (
            <div className="flex rounded-full border border-line p-1" role="group" aria-label="What the code opens">
              {(['whatsapp', 'web'] as const).map((option) => (
                <Link
                  key={option}
                  href={`?kind=${option}`}
                  aria-current={kind === option ? 'page' : undefined}
                  className={`rounded-full px-3.5 py-1.5 text-[14px] font-medium ${
                    kind === option ? 'bg-ink text-white' : 'text-muted hover:text-ink'
                  }`}
                >
                  {option === 'whatsapp' ? 'Opens WhatsApp' : 'Opens booking page'}
                </Link>
              ))}
            </div>
          )}
          <PrintButton />
        </div>
      </div>

      {/* The sheet. On screen, a preview of an A4 page; on paper, the page. */}
      <article
        className="mx-auto flex aspect-[210/297] w-full max-w-[595px] flex-col items-center bg-white px-[8%] pb-[7%] pt-[9%] text-center text-ink shadow-[0_1px_3px_rgb(0_0_0/0.08),0_8px_30px_rgb(0_0_0/0.06)] print:h-[296mm] print:w-[210mm] print:max-w-none print:overflow-hidden print:shadow-none"
        style={{ borderTop: `14px solid ${accent}` }}
      >
        <p className="text-[clamp(28px,6.5vw,44px)] font-bold leading-tight tracking-[-0.03em] print:text-[44pt]">{business.name}</p>
        {business.profile?.tagline ? (
          <p className="mt-2 text-[clamp(14px,2.6vw,18px)] text-muted print:text-[15pt]">{business.profile.tagline}</p>
        ) : null}

        <p className="mt-[7%] text-[clamp(20px,4.4vw,30px)] font-bold tracking-[-0.02em] print:text-[26pt]">
          {kind === 'whatsapp' ? 'Scan to book on WhatsApp' : 'Scan to book online'}
        </p>

        <div className="mt-[4%] w-[62%] rounded-2xl border-[3px] border-ink p-[3%]">
          <QrCode
            value={kind === 'whatsapp' ? invite!.link : webLink}
            label={kind === 'whatsapp' ? `QR code: message ${business.name} on WhatsApp` : `QR code: ${business.name} booking page`}
            className="block h-auto w-full"
          />
        </div>

        <ol className="mt-[6%] grid w-full grid-cols-3 gap-3 text-[clamp(12px,2.2vw,15px)] print:text-[12pt]">
          {(kind === 'whatsapp'
            ? ['Open your camera', 'Point it at the code', 'Send the message, we reply with times']
            : ['Open your camera', 'Point it at the code', 'Pick a time, confirmed on WhatsApp']
          ).map((step, index) => (
            <li key={step} className="flex flex-col items-center gap-1.5">
              <span
                className="flex h-8 w-8 items-center justify-center rounded-full text-[15px] font-bold text-white print:[print-color-adjust:exact]"
                style={{ background: accent }}
              >
                {index + 1}
              </span>
              <span className="leading-snug">{step}</span>
            </li>
          ))}
        </ol>

        <div className="mt-auto text-[clamp(13px,2.4vw,16px)] print:text-[13pt]">
          {kind === 'whatsapp' ? (
            <p>
              Or message <span className="font-bold">{formatPhone(invite!.phone)}</span>
              {canWeb ? (
                <>
                  {' '}· book at <span className="font-bold">{shortWeb}</span>
                </>
              ) : null}
            </p>
          ) : (
            <p>
              Or visit <span className="font-bold">{shortWeb}</span>
            </p>
          )}
        </div>
      </article>
    </div>
  );
}
