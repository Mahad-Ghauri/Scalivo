'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACCEPTED_IMAGE_TYPES, GALLERY_MAX, checkImageFile, srcSet } from '@/lib/media';
import { sendImage } from './ImageUpload';

export interface GalleryItem {
  url: string;
  alt: string;
  imageId?: string | null;
}

/**
 * The portfolio: up to 12 photos, each with a required caption (it is the
 * alt text — screen readers and Google read it), reorderable with buttons
 * rather than drag-only, so it works from a keyboard and on a phone.
 */
export function PortfolioManager({ businessId, initial }: { businessId: string; initial: GalleryItem[] }) {
  const router = useRouter();
  const base = `/api/business/${encodeURIComponent(businessId)}/media/images/gallery`;
  const [items, setItems] = useState(initial);
  const [pending, setPending] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const full = items.length >= GALLERY_MAX;

  function choose(file: File) {
    setError(null);
    const problem = checkImageFile(file);
    if (problem) return setError(problem);
    setPending(file);
    setCaption('');
  }

  async function upload() {
    if (!pending) return;
    const alt = caption.trim();
    if (!alt) return setError('Describe the photo first, e.g. "Bridal makeup".');
    setError(null);
    setProgress(0);
    const res = await sendImage(`${base}?alt=${encodeURIComponent(alt)}`, pending, 'POST', setProgress);
    setProgress(null);
    if (res.status === 201 && res.body.image) {
      setItems((list) => [...list, { url: res.body.image!.url, alt, imageId: res.body.image!.id }]);
      setPending(null);
      router.refresh();
    } else {
      setError(res.body.error ?? 'Upload failed. Try again.');
    }
  }

  async function remove(id: string) {
    setError(null);
    const res = await fetch(`${base}/${id}`, { method: 'DELETE' });
    if (res.status === 204) {
      setItems((list) => list.filter((i) => i.imageId !== id));
      router.refresh();
    } else setError('Could not remove that photo. Reload and try again.');
  }

  async function saveCaption(id: string) {
    const alt = draft.trim();
    if (!alt) return setError('A caption is required.');
    const res = await fetch(`${base}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alt }),
    });
    if (res.status === 204) {
      setItems((list) => list.map((i) => (i.imageId === id ? { ...i, alt } : i)));
      setEditing(null);
    } else setError('Could not save the caption.');
  }

  async function move(index: number, by: -1 | 1) {
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    const ids = next.filter((i) => i.imageId).map((i) => i.imageId!);
    const previous = items;
    setItems(next); // optimistic
    const res = await fetch(`${base}/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageIds: ids }),
    });
    if (res.status !== 204) {
      setItems(previous);
      setError('The portfolio changed elsewhere. Reload and try again.');
    }
  }

  return (
    <div>
      <p className="text-[13px] text-muted">
        {items.length} of {GALLERY_MAX} photos. Show your best work — each caption is read aloud by screen readers
        and helps you appear in search.
      </p>

      <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item, index) => (
          <li key={item.imageId ?? item.url} className="rounded-lg border border-line bg-white p-2">
            <img
              src={item.url}
              srcSet={srcSet(item.url)}
              sizes="(max-width: 640px) 50vw, 240px"
              alt={item.alt}
              loading="lazy"
              className="aspect-square w-full rounded-md object-cover"
            />
            {editing === item.imageId ? (
              <div className="mt-2 flex gap-1">
                <input
                  value={draft}
                  maxLength={200}
                  onChange={(e) => setDraft(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-line px-2 py-1 text-xs"
                  aria-label="Caption"
                />
                <button type="button" onClick={() => saveCaption(item.imageId!)} className="text-xs font-medium text-brand">
                  Save
                </button>
              </div>
            ) : (
              <p className="mt-2 line-clamp-2 text-xs text-ink">{item.alt}</p>
            )}
            {item.imageId && (
              <div className="mt-1.5 flex flex-wrap gap-x-2 text-xs">
                <button type="button" disabled={index === 0} onClick={() => move(index, -1)} className="text-muted hover:text-ink disabled:opacity-30" aria-label={`Move "${item.alt}" earlier`}>
                  ←
                </button>
                <button type="button" disabled={index === items.length - 1} onClick={() => move(index, 1)} className="text-muted hover:text-ink disabled:opacity-30" aria-label={`Move "${item.alt}" later`}>
                  →
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(item.imageId!);
                    setDraft(item.alt);
                  }}
                  className="text-muted hover:text-ink"
                >
                  Caption
                </button>
                <button type="button" onClick={() => remove(item.imageId!)} className="text-muted hover:text-red-700">
                  Delete
                </button>
              </div>
            )}
          </li>
        ))}

        {!full && !pending && (
          <li>
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="flex aspect-square w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-line text-sm text-muted hover:border-brand hover:text-ink"
            >
              <span className="text-xl" aria-hidden>
                ＋
              </span>
              Add photo
            </button>
          </li>
        )}
      </ul>

      <input
        ref={input}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        className="sr-only"
        aria-label="Add a portfolio photo"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) choose(file);
        }}
      />

      {pending && (
        <div className="mt-4 rounded-lg border border-line p-4">
          <p className="text-sm font-medium text-ink">New photo: {pending.name}</p>
          <label className="mt-2 block text-[13px] text-muted">
            Caption (required)
            <input
              value={caption}
              maxLength={200}
              onChange={(e) => setCaption(e.target.value)}
              placeholder='e.g. "Balayage on shoulder-length hair"'
              className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm text-ink"
            />
          </label>
          {progress !== null && (
            <div className="mt-3 h-1.5 rounded bg-line" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded bg-brand" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={upload}
              disabled={progress !== null}
              className="rounded-full bg-ink px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {progress !== null ? 'Uploading…' : 'Upload'}
            </button>
            <button type="button" onClick={() => setPending(null)} disabled={progress !== null} className="px-3 py-1.5 text-sm text-muted">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
