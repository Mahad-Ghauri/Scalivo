'use client';

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex h-10 items-center rounded-full bg-ink px-5 text-[15px] font-semibold text-white hover:bg-black/80"
    >
      Print poster
    </button>
  );
}
