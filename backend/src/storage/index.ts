import { env } from '../config/env.js';
import { S3Client } from './s3.js';

/**
 * Where uploaded images live. The app depends on this interface, not on R2,
 * so tests run against an in-memory store and the bucket can change provider
 * by changing STORAGE_* only.
 */
export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** The browser-facing URL for a key. Never the signed API host. */
  publicUrl(key: string): string;
  /** The key behind a URL this store issued, or null for any other URL. */
  keyFromUrl(url: string): string | null;
}

/**
 * Object keys are content-addressed per upload (a fresh random id each time),
 * so an object never changes once written and may be cached forever.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly base: string;

  constructor(config: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicUrl: string;
  }) {
    this.client = new S3Client(config);
    this.base = config.publicUrl.replace(/\/+$/, '');
  }

  put(key: string, body: Uint8Array, contentType: string) {
    return this.client.putObject(key, body, { contentType, cacheControl: IMMUTABLE });
  }

  delete(key: string) {
    return this.client.deleteObject(key);
  }

  list(prefix: string) {
    return this.client.listKeys(prefix);
  }

  publicUrl(key: string) {
    return `${this.base}/${key}`;
  }

  keyFromUrl(url: string) {
    return url.startsWith(`${this.base}/`) ? url.slice(this.base.length + 1) : null;
  }
}

let store: ObjectStore | null | undefined;

/** The configured store, or null when STORAGE_* is unset (uploads then answer 503). */
export function objectStore(): ObjectStore | null {
  if (store !== undefined) return store;
  store =
    env.STORAGE_ENDPOINT &&
    env.STORAGE_REGION &&
    env.STORAGE_BUCKET &&
    env.STORAGE_ACCESS_KEY_ID &&
    env.STORAGE_SECRET_ACCESS_KEY &&
    env.STORAGE_PUBLIC_URL
      ? new S3ObjectStore({
          endpoint: env.STORAGE_ENDPOINT,
          region: env.STORAGE_REGION,
          bucket: env.STORAGE_BUCKET,
          accessKeyId: env.STORAGE_ACCESS_KEY_ID,
          secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
          publicUrl: env.STORAGE_PUBLIC_URL,
        })
      : null;
  return store;
}

/** Tests swap in a fake; null restores the configured one. */
export function useObjectStore(next: ObjectStore | null | undefined): void {
  store = next;
}

/** In-memory store for tests. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  failPuts = false;
  failDeletes = false;

  constructor(private readonly base = 'https://images.test') {}

  async put(key: string, body: Uint8Array, contentType: string) {
    if (this.failPuts) throw new Error('simulated storage outage');
    this.objects.set(key, { body, contentType });
  }

  async delete(key: string) {
    if (this.failDeletes) throw new Error('simulated storage outage');
    this.objects.delete(key);
  }

  async list(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }

  publicUrl(key: string) {
    return `${this.base}/${key}`;
  }

  keyFromUrl(url: string) {
    return url.startsWith(`${this.base}/`) ? url.slice(this.base.length + 1) : null;
  }
}
