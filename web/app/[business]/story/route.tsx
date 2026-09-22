import { ImageResponse } from 'next/og';
import { categoryLabel, getBusinessBySlug } from '@/lib/marketplace';
import { SITE_URL } from '@/lib/site';

/**
 * A 1080×1920 Instagram story announcing online booking (SPEC §10, "pre-formatted
 * for Instagram Stories"). The owner downloads it from Grow, posts it, and adds
 * the link sticker Instagram gives them — a story image cannot carry a working
 * link itself, which is why the address is also printed on it.
 *
 * Public data only, and only for a published business: this renders nothing a
 * stranger could not read on the profile page.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ business: string }> }) {
  const business = await getBusinessBySlug((await params).business);
  if (!business) return new Response('Not found', { status: 404 });

  const accent = business.themeColor ?? '#6950f3';
  const place = [business.neighbourhood, business.city].filter(Boolean).join(', ');
  const address = `${SITE_URL.replace(/^https?:\/\//, '')}/${business.slug}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '140px 90px 160px',
          background: `linear-gradient(160deg, ${accent} 0%, #1a1340 100%)`,
          color: '#fff',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* One string, not two children: the renderer (satori) wants flex on any multi-child box. */}
          <div style={{ fontSize: 40, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 6 }}>
            {`${categoryLabel(business.category)}${place ? ` · ${place}` : ''}`}
          </div>
          <div style={{ marginTop: 36, fontSize: 124, fontWeight: 700, lineHeight: 1.02, letterSpacing: -4 }}>
            {business.name}
          </div>
          {business.tagline ? (
            <div style={{ marginTop: 36, fontSize: 48, lineHeight: 1.3, opacity: 0.9 }}>{business.tagline}</div>
          ) : null}
          {business.rating !== null ? (
            <div style={{ marginTop: 48, fontSize: 48, display: 'flex', alignItems: 'center' }}>
              {/* A drawn star, not the ★ glyph: the bundled font has no such character,
                  and fetching one at render time fails offline. */}
              <svg width="44" height="44" viewBox="0 0 24 24" style={{ marginRight: 16 }}>
                <path fill="#ffb900" d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01z" />
              </svg>
              {`${business.rating.toFixed(1)} · ${business.reviewCount} reviews`}
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          <div style={{ fontSize: 88, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }}>Book online now</div>
          <div style={{ marginTop: 24, fontSize: 44, lineHeight: 1.35, opacity: 0.9 }}>
            Pick a time in under a minute. Confirmed on WhatsApp.
          </div>
          <div
            style={{
              marginTop: 64,
              display: 'flex',
              padding: '28px 48px',
              borderRadius: 999,
              background: '#fff',
              color: '#0d0d0d',
              fontSize: 44,
              fontWeight: 700,
            }}
          >
            {address}
          </div>
        </div>
      </div>
    ),
    {
      width: 1080,
      height: 1920,
      headers: {
        'Content-Disposition': `attachment; filename="${business.slug}-story.png"`,
        // Same freshness as the profile it mirrors.
        'Cache-Control': 'public, max-age=300',
      },
    },
  );
}
