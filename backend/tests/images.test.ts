import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signToken } from '../src/auth/jwt.js';
import { Business } from '../src/models/Business.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { StoredImage } from '../src/models/StoredImage.js';
import { createImageRouter } from '../src/images/routes.js';
import { ImageRejected, processImage, sniff } from '../src/images/process.js';
import { GALLERY_MAX, uploadImage } from '../src/images/service.js';
import { sweepImages } from '../src/images/sweep.js';
import { MemoryObjectStore, useObjectStore } from '../src/storage/index.js';
import { infraReady } from './infra.js';

/* ─────────────────────────── test images ─────────────────────────── */

const photo = (width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'jpeg') => {
  const stripe = Buffer.from(
    `<svg width="${width}" height="${height}"><rect x="0" y="0" width="${Math.round(width / 3)}" height="${height}" fill="#205080"/></svg>`,
  );
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 90 } },
  }).composite([{ input: stripe }]);
  return image[format]().toBuffer();
};

/** A portrait phone photo stored sideways (EXIF orientation 6) carrying GPS + owner details. */
const phonePhoto = () =>
  sharp({ create: { width: 1200, height: 800, channels: 3, background: '#88aa44' } })
    .jpeg()
    .withExif({
      IFD0: { Copyright: 'SECRET-OWNER-NAME', Artist: 'SECRET-ARTIST', Make: 'PhoneCo' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '30/1 11/1 51/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '71/1 28/1 30/1',
      },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();

/* ──────────────────────────── processing ─────────────────────────── */

describe('image processing', () => {
  it('detects formats by their bytes, not their name', async () => {
    expect(sniff(await photo(10, 10, 'jpeg'))).toBe('jpeg');
    expect(sniff(await photo(10, 10, 'png'))).toBe('png');
    expect(sniff(await photo(10, 10, 'webp'))).toBe('webp');
    expect(
      sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
    ).toBeNull();
    expect(sniff(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniff(Buffer.alloc(0))).toBeNull();
  });

  it('strips EXIF, GPS and identity metadata, and applies orientation', async () => {
    const input = await phonePhoto();
    expect(input.includes('SECRET-OWNER-NAME')).toBe(true); // the test input really carries it

    const [large] = await processImage(input, 'gallery');
    const meta = await sharp(large!.body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    for (const secret of ['SECRET-OWNER-NAME', 'SECRET-ARTIST', 'PhoneCo', 'GPS']) {
      expect(large!.body.includes(secret), secret).toBe(false);
    }
    // Stored 1200×800 with orientation 6 → displayed portrait.
    expect(large!.height).toBeGreaterThan(large!.width);
  });

  it('crops each kind to its shape and size', async () => {
    const src = await photo(3000, 2000);
    const sizes = async (kind: Parameters<typeof processImage>[1]) =>
      (await processImage(src, kind)).map((v) => `${v.width}x${v.height}`);
    expect(await sizes('logo')).toEqual(['512x512', '256x256']);
    expect(await sizes('cover')).toEqual(['1920x1280', '1280x853', '640x427']);
    expect(await sizes('service')).toEqual(['1200x900', '600x450']);
    expect(await sizes('staff')).toEqual(['512x512', '256x256']);
    expect(await sizes('gallery')).toEqual(['1600x1067', '800x533']);
  });

  it('never enlarges gallery photos', async () => {
    const out = await processImage(await photo(900, 600), 'gallery');
    expect(out.map((v) => v.width)).toEqual([900, 800]);
  });

  it('refuses SVG, junk, truncated files, tiny images and decompression bombs', async () => {
    const reason = (p: Promise<unknown>) =>
      p.then(
        () => 'accepted',
        (e: unknown) => (e instanceof ImageRejected ? e.reason : String(e)),
      );
    expect(await reason(processImage(Buffer.from('<svg/>'), 'logo'))).toBe('unsupported_format');
    expect(await reason(processImage(Buffer.from('definitely not an image'), 'logo'))).toBe(
      'unsupported_format',
    );
    const jpeg = await photo(800, 800);
    expect(await reason(processImage(jpeg.subarray(0, 400), 'logo'))).toBe('unreadable');
    expect(await reason(processImage(await photo(100, 100), 'logo'))).toBe('too_small');
    // ~51 MP of flat colour: a small file that would inflate to ~150 MB.
    const bomb = await sharp({
      create: { width: 7200, height: 7100, channels: 3, background: '#fff' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    expect(await reason(processImage(bomb, 'gallery'))).toBe('too_large');
  }, 60_000);
});

/* ───────────────────────────── HTTP layer ────────────────────────── */

interface ApiJson {
  image: { id: string; url: string; variants: { width: number; height: number; url: string }[] };
  reason?: string;
  error?: string;
}

const ready = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!ready)('image endpoints', () => {
  let redis: Redis;
  let store: MemoryObjectStore;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let businessId: string;
  let otherBusinessId: string;
  let serviceId: string;
  let otherServiceId: string;
  let staffId: string;
  let token: string;
  let jpeg: Buffer;

  const call = async (
    method: string,
    path: string,
    body?: Buffer | object,
    bearer: string | null = token,
  ) => {
    const isImage = Buffer.isBuffer(body);
    const res = await fetch(`${base}/businesses/${businessId}${path}`, {
      method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body ? { 'Content-Type': isImage ? 'image/jpeg' : 'application/json' } : {}),
      },
      ...(body ? { body: isImage ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      json: text ? (JSON.parse(text) as ApiJson) : null,
    };
  };

  const rows = (status?: string) =>
    StoredImage.find({ businessId, ...(status ? { status } : {}) }).lean();

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 10 });
    const stamp = Date.now();
    const [b, o] = await Business.create([
      { name: 'Images Salon', slug: `img-${stamp}`, category: 'salon' },
      { name: 'Other Salon', slug: `img-other-${stamp}`, category: 'salon' },
    ]);
    businessId = String(b!._id);
    otherBusinessId = String(o!._id);
    token = signToken({ userId: 'img-owner', role: 'owner', businessIds: [businessId] });
    jpeg = await photo(2400, 1600);
    const app = express();
    app.use('/businesses', createImageRouter(redis));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    store = new MemoryObjectStore();
    useObjectStore(store);
    await redis.flushdb();
    await Promise.all([
      StoredImage.deleteMany({ businessId: { $in: [businessId, otherBusinessId] } }),
      Service.deleteMany({ businessId: { $in: [businessId, otherBusinessId] } }),
      Staff.deleteMany({ businessId: { $in: [businessId, otherBusinessId] } }),
      Business.updateOne(
        { _id: businessId },
        { $set: { 'profile.logoUrl': null, 'profile.coverUrl': null, 'profile.gallery': [] } },
      ),
    ]);
    serviceId = String(
      (await Service.create({ businessId, name: 'Facial', durationMinutes: 30, priceMinor: 1 }))
        ._id,
    );
    otherServiceId = String(
      (
        await Service.create({
          businessId: otherBusinessId,
          name: 'Theirs',
          durationMinutes: 30,
          priceMinor: 1,
        })
      )._id,
    );
    staffId = String((await Staff.create({ businessId, name: 'Ayesha' }))._id);
  });

  afterAll(async () => {
    useObjectStore(undefined);
    await Promise.all([
      StoredImage.deleteMany({ businessId: { $in: [businessId, otherBusinessId] } }),
      Service.deleteMany({ businessId: { $in: [businessId, otherBusinessId] } }),
      Staff.deleteMany({ businessId: { $in: [businessId, otherBusinessId] } }),
      Business.deleteMany({ _id: { $in: [businessId, otherBusinessId] } }),
    ]);
    await new Promise<void>((r) => server.close(() => r()));
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  it('uploads a logo: WebP variants stored, URL saved, response exposes public URLs only', async () => {
    const res = await call('PUT', '/images/logo', jpeg);
    expect(res.status).toBe(201);
    const image = res.json!.image;
    expect(Object.keys(res.json!)).toEqual(['image']);
    expect(Object.keys(image).sort()).toEqual(['id', 'url', 'variants']);
    expect(image.id).toMatch(/^[0-9a-f]{32}$/);
    expect(image.url).toBe(`https://images.test/b/${businessId}/logo/${image.id}/512.webp`);
    expect(
      image.variants.map((v: { width: number; height: number }) => `${v.width}x${v.height}`),
    ).toEqual(['512x512', '256x256']);
    // Nothing about the backend's storage configuration in the response.
    for (const leak of [
      'cloudflarestorage',
      'bucket',
      'secret',
      'accessKey',
      'Signature',
      'x-amz',
    ]) {
      expect(res.text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
    expect(store.objects.size).toBe(2);
    for (const { contentType } of store.objects.values()) expect(contentType).toBe('image/webp');
    expect((await Business.findById(businessId))!.profile!.logoUrl).toBe(image.url);
    expect((await rows('active')).map((r) => r.imageId)).toEqual([image.id]);
  });

  it('replacing deletes the old files; removing clears the field and the files', async () => {
    const first = (await call('PUT', '/images/cover', jpeg)).json!.image;
    const second = (await call('PUT', '/images/cover', jpeg)).json!.image;
    expect(first.id).not.toBe(second.id);
    expect([...store.objects.keys()].every((k) => k.includes(second.id))).toBe(true);
    expect(store.objects.size).toBe(3);
    expect((await StoredImage.findOne({ imageId: first.id }))!.status).toBe('deleted');

    expect((await call('DELETE', '/images/cover')).status).toBe(204);
    expect((await Business.findById(businessId))!.profile!.coverUrl).toBeNull();
    expect(store.objects.size).toBe(0);
    expect(await rows('active')).toHaveLength(0);
  });

  it('five uploads racing for one slot keep exactly the one the business points at', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call('PUT', '/images/logo', jpeg)),
    );
    expect(results.every((r) => r.status === 201 || r.status === 503)).toBe(true);
    const logoUrl = (await Business.findById(businessId))!.profile!.logoUrl!;
    const active = await rows('active');
    expect(active).toHaveLength(1);
    expect(logoUrl).toContain(active[0]!.imageId);
    expect([...store.objects.keys()].every((k) => k.includes(active[0]!.imageId))).toBe(true);
  });

  it('gallery: alt required, capped at 12 even under concurrency, reorder, caption, delete', async () => {
    expect((await call('POST', '/images/gallery', jpeg)).status).toBe(400); // no alt
    for (let i = 0; i < GALLERY_MAX - 2; i++) {
      expect(
        (await call('POST', `/images/gallery?alt=${encodeURIComponent(`Work ${i}`)}`, jpeg)).status,
      ).toBe(201);
    }
    const burst = await Promise.all(
      Array.from({ length: 5 }, (_, i) => call('POST', `/images/gallery?alt=Burst${i}`, jpeg)),
    );
    expect(burst.filter((r) => r.status === 201)).toHaveLength(2);
    expect(
      burst
        .filter((r) => r.status !== 201)
        .every((r) => r.json!.reason === 'gallery_full' || r.status === 503),
    ).toBe(true);
    const gallery = (await Business.findById(businessId))!.profile!.gallery;
    expect(gallery).toHaveLength(GALLERY_MAX);
    expect(store.objects.size).toBe(GALLERY_MAX * 2); // losers' files deleted

    const ids = gallery.map((g) => g.imageId!);
    expect(
      (await call('PUT', '/images/gallery/order', { imageIds: [...ids].reverse() })).status,
    ).toBe(204);
    expect((await Business.findById(businessId))!.profile!.gallery.map((g) => g.imageId)).toEqual(
      [...ids].reverse(),
    );
    expect((await call('PUT', '/images/gallery/order', { imageIds: ids.slice(1) })).status).toBe(
      409,
    );

    expect(
      (await call('PATCH', `/images/gallery/${ids[0]}`, { alt: 'Bridal makeup' })).status,
    ).toBe(204);
    expect((await call('DELETE', `/images/gallery/${ids[0]}`)).status).toBe(204);
    const after = (await Business.findById(businessId))!.profile!.gallery;
    expect(after).toHaveLength(GALLERY_MAX - 1);
    expect([...store.objects.keys()].some((k) => k.includes(ids[0]!))).toBe(false);
    expect((await call('DELETE', `/images/gallery/${ids[0]}`)).status).toBe(404);
  }, 120_000);

  it('service and staff images, with consent required for staff', async () => {
    const svc = await call('PUT', `/services/${serviceId}/image`, jpeg);
    expect(svc.status).toBe(201);
    expect(
      svc.json!.image.variants.map(
        (v: { width: number; height: number }) => `${v.width}x${v.height}`,
      ),
    ).toEqual(['1200x900', '600x450']);
    expect((await Service.findById(serviceId))!.imageUrl).toBe(svc.json!.image.url);

    expect((await call('PUT', `/staff/${staffId}/photo`, jpeg)).json!.reason).toBe(
      'consent_required',
    );
    expect((await call('PUT', `/staff/${staffId}/photo?consent=true`, jpeg)).status).toBe(201);
    const member = await Staff.findById(staffId);
    expect(member!.avatarUrl).toMatch(/\/staff\/[0-9a-f]{32}\/512\.webp$/);
    expect(member!.photoConsentAt).toBeInstanceOf(Date);

    expect((await call('DELETE', `/staff/${staffId}/photo`)).status).toBe(204);
    const cleared = await Staff.findById(staffId);
    expect(cleared!.avatarUrl).toBeNull();
    expect(cleared!.photoConsentAt).toBeNull();
  });

  it("refuses another business's service, and callers who are not this owner", async () => {
    expect((await call('PUT', `/services/${otherServiceId}/image`, jpeg)).status).toBe(404);
    expect((await call('PUT', `/services/not-an-id/image`, jpeg)).status).toBe(404);
    expect(store.objects.size).toBe(0);
    expect(await StoredImage.countDocuments({ businessId })).toBe(0);

    const staff = signToken({ userId: 's', role: 'staff', businessIds: [businessId] });
    const other = signToken({ userId: 'o', role: 'owner', businessIds: [otherBusinessId] });
    expect((await call('PUT', '/images/logo', jpeg, null)).status).toBe(401);
    expect((await call('PUT', '/images/logo', jpeg, staff)).status).toBe(404);
    expect((await call('PUT', '/images/logo', jpeg, other)).status).toBe(404);
    expect(store.objects.size).toBe(0);
  });

  it('rejects bad uploads with clear JSON errors and stores nothing', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect((await call('PUT', '/images/logo', svg)).json).toMatchObject({
      reason: 'unsupported_format',
    });
    expect((await call('PUT', '/images/logo', Buffer.alloc(0))).status).toBe(400);
    const tooBig = await call('PUT', '/images/logo', Buffer.alloc(9 * 1024 * 1024, 1));
    expect(tooBig.status).toBe(413);
    expect(tooBig.json).toMatchObject({ reason: 'too_large' });
    expect((await call('PUT', '/images/logo', await photo(64, 64))).json).toMatchObject({
      reason: 'too_small',
    });
    expect(store.objects.size).toBe(0);
    expect(await StoredImage.countDocuments({ businessId })).toBe(0);
  });

  it('storage outage: 503 with a generic message, nothing half-saved', async () => {
    store.failPuts = true;
    const res = await call('PUT', '/images/logo', jpeg);
    expect(res.status).toBe(503);
    expect(res.json).toEqual({
      error: 'Image uploads are unavailable right now. Try again shortly.',
      reason: 'storage_unavailable',
    });
    expect((await Business.findById(businessId))!.profile!.logoUrl ?? null).toBeNull();
    expect(await rows('active')).toHaveLength(0);
  });

  it('a delete that fails is retried by the sweeper; crashed uploads are cleaned or promoted', async () => {
    await call('PUT', '/images/logo', jpeg);
    store.failDeletes = true;
    const second = (await call('PUT', '/images/logo', jpeg)).json!.image;
    expect(await rows('released')).toHaveLength(1);
    expect(store.objects.size).toBe(4); // old files still there

    store.failDeletes = false;
    expect((await sweepImages(store)).deleted).toBe(1);
    expect(store.objects.size).toBe(2);
    expect([...store.objects.keys()].every((k) => k.includes(second.id))).toBe(true);

    // A crash after attach but before "active": still referenced → promoted, never deleted.
    await StoredImage.updateOne(
      { imageId: second.id },
      { $set: { status: 'pending', updatedAt: new Date(Date.now() - 2 * 3_600_000) } },
      { timestamps: false },
    );
    expect((await sweepImages(store)).promoted).toBe(1);
    expect(store.objects.size).toBe(2);

    // A crash before attach: unreferenced pending → deleted.
    await store.put(
      `b/${businessId}/logo/${'f'.repeat(32)}/512.webp`,
      Buffer.from('x'),
      'image/webp',
    );
    await StoredImage.create({
      imageId: 'f'.repeat(32),
      businessId,
      kind: 'logo',
      widths: [512],
      bytes: 1,
      status: 'pending',
    });
    await StoredImage.updateOne(
      { imageId: 'f'.repeat(32) },
      { $set: { updatedAt: new Date(Date.now() - 2 * 3_600_000) } },
      { timestamps: false },
    );
    await sweepImages(store);
    expect(store.objects.has(`b/${businessId}/logo/${'f'.repeat(32)}/512.webp`)).toBe(false);
  });

  it('rate-limits per business and answers 503 when storage is not configured', async () => {
    await redis.set(`rl:images:${businessId}:${Math.floor(Date.now() / 3_600_000)}`, '60');
    expect((await call('PUT', '/images/logo', jpeg)).status).toBe(429);
    await redis.flushdb();
    useObjectStore(null);
    expect((await call('PUT', '/images/logo', jpeg)).json).toMatchObject({
      reason: 'storage_unavailable',
    });
  });

  it('processes a 12 MP phone photo fast enough to be interactive', async () => {
    const big = await photo(4000, 3000);
    const t0 = performance.now();
    await uploadImage(store, { businessId, kind: 'gallery' }, big, { alt: 'Big' });
    const ms = performance.now() - t0;
    console.log(`12 MP gallery upload processed + stored in ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(5_000);
  });
});
