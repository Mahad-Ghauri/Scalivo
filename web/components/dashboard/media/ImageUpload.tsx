'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACCEPTED_IMAGE_TYPES, checkImageFile, srcSet } from '@/lib/media';

export type Aspect = 'square' | 'cover' | 'service' | 'free';

const ASPECT_CLASS: Record<Aspect, string> = {
  square: 'aspect-square w-32',
  cover: 'aspect-[3/2] w-full max-w-md',
  service: 'aspect-[4/3] w-full max-w-xs',
  free: 'aspect-[4/3] w-full max-w-xs',
};

export interface UploadResult {
  id: string;
  url: string;
}

/**
 * Upload with progress, sent as the raw file body to the media proxy
 * (app/api/business/[businessId]/media). XHR rather than fetch: fetch cannot
 * report upload progress, and an 8 MB photo on a slow mobile link deserves a
 * progress bar.
 */
export function sendImage(
  url: string,
  file: File,
  method: 'PUT' | 'POST',
  onProgress?: (fraction: number) => void,
): Promise<{ status: number; body: { image?: UploadResult; error?: string; reason?: string } }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        /* non-JSON error page */
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ status: 0, body: { error: 'Network error. Check your connection.' } });
    xhr.timeout = 90_000;
    xhr.ontimeout = () => resolve({ status: 0, body: { error: 'The upload timed out. Try again.' } });
    xhr.send(file);
  });
}

export function ImageUpload({
  endpoint,
  label,
  hint,
  currentUrl,
  aspect,
  alt,
  query,
  beforeUpload,
  onChange,
}: {
  /** e.g. `/api/business/<id>/media/images/logo` */
  endpoint: string;
  label: string;
  hint?: string;
  currentUrl: string | null | undefined;
  aspect: Aspect;
  alt: string;
  /** Extra query string, e.g. `consent=true`. */
  query?: string;
  /** Return an error message to block the upload (e.g. consent not ticked). */
  beforeUpload?: () => string | null;
  onChange?: (url: string | null) => void;
}) {
  const router = useRouter();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(currentUrl ?? null);
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const busy = progress !== null;

  async function upload(file: File) {
    setError(null);
    const blocked = beforeUpload?.() ?? checkImageFile(file);
    if (blocked) return setError(blocked);

    const local = URL.createObjectURL(file);
    setPreview(local);
    setProgress(0);
    const res = await sendImage(`${endpoint}${query ? `?${query}` : ''}`, file, 'PUT', setProgress);
    setProgress(null);
    URL.revokeObjectURL(local);
    setPreview(null);

    if (res.status === 201 && res.body.image) {
      setUrl(res.body.image.url);
      onChange?.(res.body.image.url);
      router.refresh();
    } else {
      setError(res.body.error ?? 'Upload failed. Try again.');
    }
  }

  async function remove() {
    setError(null);
    setProgress(0);
    const res = await fetch(endpoint, { method: 'DELETE' });
    setProgress(null);
    if (res.status === 204) {
      setUrl(null);
      onChange?.(null);
      router.refresh();
    } else {
      setError('Could not remove the image. Try again.');
    }
  }

  const shown = preview ?? url;

  return (
    <div>
      <label htmlFor={inputId} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file && !busy) void upload(file);
        }}
        className={`relative mt-2 overflow-hidden rounded-lg border-2 border-dashed ${ASPECT_CLASS[aspect]} ${
          dragging ? 'border-brand bg-brand/5' : 'border-line bg-surface'
        }`}
      >
        {shown ? (
          <img
            src={shown}
            srcSet={preview ? undefined : srcSet(shown)}
            sizes="(max-width: 640px) 100vw, 400px"
            alt={alt}
            className={`h-full w-full object-cover ${busy ? 'opacity-60' : ''}`}
          />
        ) : (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="flex h-full w-full flex-col items-center justify-center gap-1 p-3 text-center text-[13px] text-muted hover:text-ink"
          >
            <span className="text-xl" aria-hidden>
              ＋
            </span>
            Add photo
            <span className="text-[11px]">or drop it here</span>
          </button>
        )}
        {busy && (
          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-line" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-brand transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>

      <input
        id={inputId}
        ref={input}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        className="sr-only"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />

      <div className="mt-2 flex gap-3 text-sm">
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy}
          className="font-medium text-brand hover:underline disabled:opacity-50"
        >
          {busy ? 'Uploading…' : url ? 'Replace' : 'Upload'}
        </button>
        {url && !busy && (
          <button type="button" onClick={remove} className="text-muted hover:text-red-700">
            Remove
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
      <p className="mt-1 text-[11px] text-muted">JPEG, PNG or WebP, up to 8 MB. Location data is removed.</p>
    </div>
  );
}
