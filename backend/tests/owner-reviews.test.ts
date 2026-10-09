import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Review } from '../src/models/Review.js';
import { createReviewRouter } from '../src/reviews/routes.js';
import { signToken } from '../src/auth/jwt.js';
import { infraReady } from './infra.js';

const infraUp = await infraReady();
describe.skipIf(!infraUp)('owner review pages', () => {
  const businessId = 'owner-review-mobile-test';
  const token = signToken({ userId: 'owner-review', role: 'owner', businessIds: [businessId] });
  let url: string;
  let server: ReturnType<express.Express['listen']>;
  const get = (query = '', bearer: string | null = token) => fetch(`${url}/businesses/${businessId}/reviews${query}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  beforeAll(() => {
    const app = express();
    app.use('/businesses', createReviewRouter());
    server = app.listen(0);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => { await Review.deleteMany({ businessId }); });
  afterAll(async () => {
    await Review.deleteMany({ businessId });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mongoose.disconnect();
  });
  it('requires owner authorization before reading private reviews', async () => {
    expect((await get('', null)).status).toBe(401);
    const other = signToken({ userId: 'other', role: 'owner', businessIds: ['other'] });
    const staff = signToken({ userId: 'staff', role: 'staff', businessIds: [businessId] });
    expect((await get('', other)).status).toBe(404);
    expect((await get('', staff)).status).toBe(404);
  });
  it('bounds offset and refuses invalid filter values', async () => {
    for (const query of ['?skip=10001', '?skip=-1', '?limit=201', '?filter=private-data']) {
      expect((await get(query)).status).toBe(400);
    }
  });
  it('paginates deterministically when timestamps match and includes low ratings privately', async () => {
    await Review.insertMany(Array.from({ length: 21 }, (_, i) => ({
      businessId, authorName: `Test ${i}`, rating: i === 0 ? 2 : 5,
      published: i !== 0, comment: '', createdAt: new Date('2026-10-09T00:00:00Z'),
    })));
    const first = await (await get('?limit=20')).json() as { total: number; reviews: { id: string }[] };
    const second = await (await get('?limit=20&skip=20')).json() as { total: number; reviews: { id: string }[] };
    expect(first.total).toBe(21);
    expect(first.reviews).toHaveLength(20);
    expect(second.reviews).toHaveLength(1);
    expect(new Set([...first.reviews, ...second.reviews].map((r) => r.id)).size).toBe(21);
    const flagged = await (await get('?filter=flagged')).json() as { reviews: { rating: number; published: boolean }[] };
    expect(flagged.reviews).toHaveLength(1);
    expect(flagged.reviews[0]).toMatchObject({ rating: 2, published: false });
  });
});
