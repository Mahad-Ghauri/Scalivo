import { ImageResponse } from 'next/og';

/**
 * The card that appears when a Scalivo link is shared — milestone 4.3.
 *
 * The root layout already declares `twitter: { card: 'summary_large_image' }`,
 * which without an image produces a blank grey rectangle: worse than declaring
 * nothing, because the platform reserves the space for it. This fills it.
 *
 * It is the FALLBACK. A business profile sets its own `openGraph.images` from
 * the cover photo when it has one, and that wins — a shared link to a salon
 * should show the salon, not our logo. This covers the home page, search, and
 * any business that has not uploaded a cover yet.
 *
 * Drawn here rather than shipped as a PNG so it stays in step with the brand
 * tokens, and so there is no binary in the repo that nobody can edit.
 */
export const alt = 'Scalivo — book salons, clinics, gyms and studios';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#6950f3',
          padding: 72,
          // Satori has no default font stack and no cascade — every style is
          // explicit, and anything inherited from a stylesheet is simply absent.
          fontFamily: 'sans-serif',
          color: '#ffffff',
        }}
      >
        <div style={{ display: 'flex', fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>Scalivo</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', fontSize: 76, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2.5 }}>
            Book local selfcare services
          </div>
          <div style={{ display: 'flex', fontSize: 32, opacity: 0.85 }}>
            Salons, clinics, gyms and studios — booked over WhatsApp.
          </div>
        </div>
      </div>
    ),
    size,
  );
}
