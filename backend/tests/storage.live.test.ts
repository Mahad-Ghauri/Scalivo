import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Business } from '../src/models/Business.js';
import { StoredImage } from '../src/models/StoredImage.js';
import { S3ObjectStore } from '../src/storage/index.js';
import { removeImage, uploadImage } from '../src/images/service.js';
import { infraReady } from './infra.js';

/**
 * The real thing, against the bucket configured in backend/.env:
 *
 *   RUN_R2_LIVE=1 npx vitest run tests/storage.live.test.ts
 *
 * Skipped otherwise, so CI and ordinary runs never touch a real bucket. Every
 * object it writes is under a unique `b/<test business id>/` prefix, and
 * afterAll deletes that whole prefix and asserts it is empty — whether the
 * test passed or not. Credentials are read from the file and never printed.
 */

function storageFromEnvFile() {
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  const vars = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => /^\s*(STORAGE_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1]!, m[2]!.replace(/^['"]|['"]$/g, '')]),
  );
  const need = [
    'STORAGE_ENDPOINT',
    'STORAGE_REGION',
    'STORAGE_BUCKET',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
    'STORAGE_PUBLIC_URL',
  ];
  if (!need.every((k) => vars[k])) return null;
  return new S3ObjectStore({
    endpoint: vars.STORAGE_ENDPOINT!,
    region: vars.STORAGE_REGION!,
    bucket: vars.STORAGE_BUCKET!,
    accessKeyId: vars.STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: vars.STORAGE_SECRET_ACCESS_KEY!,
    publicUrl: vars.STORAGE_PUBLIC_URL!,
  });
}

const wanted = process.env.RUN_R2_LIVE === '1';
const store = wanted ? storageFromEnvFile() : null;
const ready = wanted && store ? await infraReady({ replicaSet: true }) : false;

describe.skipIf(!ready)('live R2: upload → serve → delete', () => {
  let businessId: string;
  const prefix = () => `b/${businessId}/`;

  beforeAll(async () => {
    const business = await Business.create({
      name: 'R2 Live Test',
      slug: `r2-live-${Date.now()}`,
      category: 'salon',
    });
    businessId = String(business._id);
  });

  afterAll(async () => {
    // Clean up no matter what happened above.
    const left = await store!.list(prefix());
    await Promise.all(left.map((k) => store!.delete(k)));
    const after = await store!.list(prefix());
    await StoredImage.deleteMany({ businessId });
    await Business.deleteOne({ _id: businessId });
    await mongoose.disconnect();
    console.log(
      `cleanup: ${left.length} leftover object(s) deleted; ${after.length} remain under the test prefix`,
    );
    expect(after).toEqual([]);
  });

  it('stores real WebP variants, serves them publicly with long caching, and deletes them', async () => {
    const photo = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: '#c08060' },
    })
      .jpeg({ quality: 90 })
      .withExif({ IFD0: { Copyright: 'LIVE-TEST-SECRET' } })
      .toBuffer();

    const t0 = performance.now();
    const image = await uploadImage(store!, { businessId, kind: 'cover' }, photo);
    const uploadMs = Math.round(performance.now() - t0);

    expect(await store!.list(prefix())).toHaveLength(3);

    const t1 = performance.now();
    for (const v of image.variants) {
      const res = await fetch(v.url);
      expect(res.status, v.url).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      const body = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(body).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', v.width, v.height]);
      expect(body.includes('LIVE-TEST-SECRET')).toBe(false);
    }
    const fetchMs = Math.round(performance.now() - t1);
    console.log(
      `12 MP photo → 3 WebP variants (${image.variants.map((v) => v.width).join('/')}): processed + uploaded in ${uploadMs} ms; all 3 fetched publicly in ${fetchMs} ms`,
    );

    // Replace via the real store, then remove: the bucket must end empty.
    const replacement = await uploadImage(store!, { businessId, kind: 'cover' }, photo);
    const keys = await store!.list(prefix());
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => k.includes(replacement.id))).toBe(true);

    await removeImage(store!, { businessId, kind: 'cover' });
    expect(await store!.list(prefix())).toEqual([]);
    const gone = await fetch(replacement.url);
    expect(gone.status).toBe(404);

    // Listing the bucket root signs correctly too (an empty prefix is omitted).
    await expect(store!.list('')).resolves.toBeInstanceOf(Array);
  }, 120_000);
});
