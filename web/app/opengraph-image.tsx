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
export const alt = 'Scalivo: book salons, clinics, gyms and studios';
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>
          {/* Inline rather than an <img>: Satori cannot fetch /brand/scalivo-logo.svg
              while rendering, so the same drawing is repeated here. */}
          <svg width="56" height="56" viewBox="0 0 512 512">
            <rect width="512" height="512" rx="104" fill="#124437" />
            <g transform="translate(-61.6 -42.6) scale(0.497)" fill="none" strokeLinecap="round" strokeLinejoin="round">
              <path d="M540 306V352M740 306V352" stroke="#FFFFFF" strokeWidth="72" />
              <path
                d="M872 420C838 396 822 390 790 390H502C440 390 398 432 398 484C398 536 440 576 492 576H742C830 576 895 646 895 738C895 830 830 900 738 900H604C510 900 432 834 418 750"
                stroke="#FFFFFF"
                strokeWidth="92"
              />
              <path d="M677 675V755L748 806" stroke="#EFB245" strokeWidth="58" />
            </g>
          </svg>
          Scalivo
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', fontSize: 76, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2.5 }}>
            Book local selfcare services
          </div>
          <div style={{ display: 'flex', fontSize: 32, opacity: 0.85 }}>
            Salons, clinics, gyms and studios, booked over WhatsApp.
          </div>
        </div>
      </div>
    ),
    size,
  );
}
