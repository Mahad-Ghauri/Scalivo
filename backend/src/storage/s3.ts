import { createHash, createHmac } from 'node:crypto';

/**
 * A minimal S3-compatible client — PUT, DELETE, LIST — signed with AWS
 * Signature Version 4. Works against Cloudflare R2, AWS S3 and MinIO.
 *
 * Written here rather than pulling in @aws-sdk/client-s3 (~3 MB, dozens of
 * packages) for three calls. The signing is the documented algorithm and is
 * exercised against the live bucket by tests/storage.live.test.ts.
 *
 * Secrets: the secret key is only ever an HMAC input. Errors carry the HTTP
 * status and the provider's error CODE — never the request, its signed
 * headers, or the response body — so nothing sensitive can reach a log line
 * or an API response.
 */

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class StorageError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(
      `storage ${operation} failed${status ? ` (HTTP ${status}${code ? ` ${code}` : ''})` : ''}`,
    );
    this.name = 'StorageError';
  }
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 requires; `/` kept in paths. */
const encode = (value: string, keepSlash = false) =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, '/');

const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;

export class S3Client {
  private readonly endpoint: URL;
  private signingKeyCache: { day: string; key: Buffer } | null = null;

  constructor(private readonly config: S3Config) {
    this.endpoint = new URL(config.endpoint);
  }

  async putObject(
    key: string,
    body: Uint8Array,
    headers: { contentType: string; cacheControl?: string },
  ): Promise<void> {
    const res = await this.send('PUT', key, {
      body,
      headers: {
        'content-type': headers.contentType,
        ...(headers.cacheControl ? { 'cache-control': headers.cacheControl } : {}),
      },
    });
    if (res.status !== 200) throw await this.fail('put', res);
  }

  /** Idempotent: a missing key is success. */
  async deleteObject(key: string): Promise<void> {
    const res = await this.send('DELETE', key);
    if (res.status !== 204 && res.status !== 200 && res.status !== 404)
      throw await this.fail('delete', res);
    await res.body?.cancel();
  }

  /** Keys under a prefix (one page of up to 1000 — callers use narrow prefixes). */
  async listKeys(prefix: string): Promise<string[]> {
    const res = await this.send('GET', '', {
      // An empty parameter is omitted, not sent as `prefix=`: R2 drops empty
      // query values before checking the signature, so signing one fails.
      query: { 'list-type': '2', 'max-keys': '1000', ...(prefix ? { prefix } : {}) },
    });
    if (res.status !== 200) throw await this.fail('list', res);
    const xml = await res.text();
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => decodeXml(m[1]!));
  }

  private async fail(operation: string, res: Response): Promise<StorageError> {
    const text = await res.text().catch(() => '');
    const code = /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(text)?.[1] ?? null;
    return new StorageError(operation, res.status, code);
  }

  /**
   * One signed request, retried on network errors, 429 and 5xx. Every call
   * here is idempotent (PUT of the same bytes, DELETE, LIST), so a retry can
   * never double anything.
   */
  private async send(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    opts: {
      body?: Uint8Array;
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const res = await this.signedFetch(method, key, opts);
        if (res.status !== 429 && res.status < 500) return res;
        lastError = await this.fail(method.toLowerCase(), res);
      } catch (err) {
        lastError = err;
      }
      if (attempt < ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 150 * 2 ** attempt + Math.random() * 100));
      }
    }
    if (lastError instanceof StorageError) throw lastError;
    // Network-level: report the operation only, never the URL or headers.
    throw new StorageError(method.toLowerCase(), null, null);
  }

  private signedFetch(
    method: string,
    key: string,
    opts: { body?: Uint8Array; headers?: Record<string, string>; query?: Record<string, string> },
  ): Promise<Response> {
    const path = `/${this.config.bucket}${key ? `/${encode(key, true)}` : ''}`;
    const query = Object.entries(opts.query ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encode(k)}=${encode(v)}`)
      .join('&');

    const amzDate = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256(opts.body ?? '');

    const headers: Record<string, string> = {
      host: this.endpoint.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(
        Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      path,
      query,
      ...names.map((n) => `${n}:${headers[n]!.trim()}`),
      '',
      names.join(';'),
      payloadHash,
    ].join('\n');

    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const signature = createHmac('sha256', this.signingKey(day)).update(stringToSign).digest('hex');
    // `host` is signed but set by fetch itself; sending it explicitly is refused.
    const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
    return fetch(`${this.endpoint.origin}${path}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        ...sent,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
      },
      ...(opts.body ? { body: opts.body } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** The derived key changes once a day; computing it per request is 4 wasted HMACs. */
  private signingKey(day: string): Buffer {
    if (this.signingKeyCache?.day === day) return this.signingKeyCache.key;
    const key = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, day), this.config.region), 's3'),
      'aws4_request',
    );
    this.signingKeyCache = { day, key };
    return key;
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
