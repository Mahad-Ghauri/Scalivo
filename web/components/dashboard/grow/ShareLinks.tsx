'use client';

import { useState } from 'react';
import type { ShareTarget } from '@/lib/grow';

/**
 * One card per place to post. Copy puts the whole ready-made caption on the
 * clipboard; the link inside it already carries that platform's `?ref=`.
 */
export function ShareLinks({ targets, storyImage }: { targets: ShareTarget[]; storyImage: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000);
    } catch {
      // Clipboard refused (insecure origin, permissions). Selecting the text is
      // still possible by hand — the caption is on screen.
      setCopied(null);
    }
  }

  return (
    <ul className="grid gap-4 md:grid-cols-2">
      {targets.map((target) => (
        <li key={target.channel} className="flex flex-col rounded-lg border border-line p-4">
          <p className="text-[15px] font-semibold text-ink">{target.title}</p>
          <p className="mt-0.5 text-[13px] text-muted">{target.hint}</p>
          <p className="mt-3 flex-1 whitespace-pre-line break-words rounded-md bg-surface px-3 py-2.5 text-[14px] text-ink">
            {target.caption}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => copy(`${target.channel}:caption`, target.caption)}
              className="inline-flex h-9 items-center rounded-full bg-ink px-4 text-[14px] font-semibold text-white hover:bg-black/80"
            >
              {copied === `${target.channel}:caption` ? 'Copied' : target.channel === 'link' ? 'Copy link' : 'Copy caption'}
            </button>
            {target.channel !== 'link' && (
              <button
                type="button"
                onClick={() => copy(`${target.channel}:link`, target.link)}
                className="inline-flex h-9 items-center rounded-full border border-line px-4 text-[14px] font-semibold text-ink hover:bg-surface"
              >
                {copied === `${target.channel}:link` ? 'Copied' : 'Copy link only'}
              </button>
            )}
            {target.intent && (
              <a
                href={target.intent}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center rounded-full border border-line px-4 text-[14px] font-semibold text-ink hover:bg-surface"
              >
                Share on {target.title.split(' ')[0]}
              </a>
            )}
            {target.channel === 'instagram' && (
              <a
                href={storyImage}
                download
                className="inline-flex h-9 items-center rounded-full border border-line px-4 text-[14px] font-semibold text-ink hover:bg-surface"
              >
                Download story image
              </a>
            )}
          </div>
          {/* Screen readers hear the confirmation that sighted users see on the button. */}
          <span className="sr-only" aria-live="polite">
            {copied?.startsWith(`${target.channel}:`) ? 'Copied to clipboard' : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
