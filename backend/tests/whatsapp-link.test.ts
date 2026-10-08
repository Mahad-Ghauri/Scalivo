import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_STATUS, type MessagingProvider } from '@scalivo/shared';
import { signToken } from '../src/auth/jwt.js';

const BIZ = '65a000000000000000000010';
const OTHER = '65a000000000000000000012';
const { businessMock } = vi.hoisted(() => ({
  businessMock: { findById: vi.fn(), updateOne: vi.fn() },
}));
vi.mock('../src/models/Business.js', () => ({ Business: businessMock }));

const provider: MessagingProvider = {
  name: 'fake',
  sendText: vi.fn<MessagingProvider['sendText']>(),
  provisionSession: vi.fn<MessagingProvider['provisionSession']>(),
  registerWebhook: vi.fn<MessagingProvider['registerWebhook']>(),
  startSession: vi.fn<MessagingProvider['startSession']>(),
  getSessionStatus: vi.fn<MessagingProvider['getSessionStatus']>(),
  getSessionQr: vi.fn<MessagingProvider['getSessionQr']>(),
  getSessionPhone: vi.fn<MessagingProvider['getSessionPhone']>(),
  resolveContactPhone: vi.fn<MessagingProvider['resolveContactPhone']>(),
  parseWebhook: vi.fn<MessagingProvider['parseWebhook']>(),
};
const servers: ReturnType<express.Express['listen']>[] = [];

async function link(scope: string | null = BIZ) {
  const { createBusinessRouter } = await import('../src/businesses/routes.js');
  const app = express();
  app.use('/businesses', createBusinessRouter(provider));
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = {};
  if (scope !== null) {
    headers.Authorization = `Bearer ${signToken({ userId: 'owner', role: 'owner', businessIds: [scope] })}`;
  }
  return fetch(`http://127.0.0.1:${port}/businesses/${BIZ}/whatsapp/link`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(5000),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  businessMock.findById.mockResolvedValue({ _id: BIZ, whatsapp: { sessionId: 'test-session' } });
  businessMock.updateOne.mockResolvedValue({ modifiedCount: 1 });
  vi.mocked(provider.startSession).mockRejectedValue(new Error('private gateway failure'));
  vi.mocked(provider.getSessionStatus).mockResolvedValue(SESSION_STATUS.FAILED);
  vi.mocked(provider.getSessionQr).mockResolvedValue(null);
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('WhatsApp linking', () => {
  it('recognizes an already connected session after start is refused', async () => {
    vi.mocked(provider.getSessionStatus).mockResolvedValue(SESSION_STATUS.READY);
    const response = await link();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: SESSION_STATUS.READY, qrCode: null });
    expect(businessMock.updateOne).toHaveBeenLastCalledWith(
      { _id: BIZ },
      {
        $set: {
          'whatsapp.status': 'ready',
          'whatsapp.intent': 'live',
          'whatsapp.lastStatusChange': expect.any(Date),
        },
      },
    );
    expect(provider.getSessionQr).not.toHaveBeenCalled();
  });

  it('retains the normal already-ready start response', async () => {
    vi.mocked(provider.startSession).mockResolvedValue({ status: SESSION_STATUS.READY });
    const response = await link();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', qrCode: null });
    expect(provider.getSessionStatus).not.toHaveBeenCalled();
  });

  it('still serves a rotating QR when the session is awaiting a scan', async () => {
    vi.mocked(provider.getSessionStatus).mockResolvedValue(SESSION_STATUS.QR_READY);
    vi.mocked(provider.getSessionQr).mockResolvedValue('current-qr');
    const response = await link();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'qr_ready', qrCode: 'current-qr' });
    expect(businessMock.updateOne).toHaveBeenCalledTimes(1);
  });

  it('still serves a QR if the status probe fails', async () => {
    vi.mocked(provider.getSessionStatus).mockRejectedValue(new Error('status unavailable'));
    vi.mocked(provider.getSessionQr).mockResolvedValue('current-qr');
    expect((await link()).status).toBe(200);
  });

  it('returns a generic failure and parks a genuinely unavailable session', async () => {
    const response = await link();
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty('error', 'private gateway failure');
    expect(businessMock.updateOne).toHaveBeenLastCalledWith(
      { _id: BIZ },
      { $set: { 'whatsapp.intent': 'stopped' } },
    );
  });

  it('does not claim success when both the status and QR probes fail', async () => {
    vi.mocked(provider.getSessionStatus).mockRejectedValue(new Error('status unavailable'));
    vi.mocked(provider.getSessionQr).mockRejectedValue(new Error('QR unavailable'));
    expect((await link()).status).toBe(502);
  });

  it('requires authentication before reading a business or calling the gateway', async () => {
    expect((await link(null)).status).toBe(401);
    expect(businessMock.findById).not.toHaveBeenCalled();
    expect(provider.startSession).not.toHaveBeenCalled();
  });

  it('hides another tenant before any database or gateway access', async () => {
    expect((await link(OTHER)).status).toBe(404);
    expect(businessMock.findById).not.toHaveBeenCalled();
    expect(provider.startSession).not.toHaveBeenCalled();
  });

  it('requests explicit setup when the business has no session', async () => {
    businessMock.findById.mockResolvedValue({ _id: BIZ });
    expect((await link()).status).toBe(409);
    expect(provider.startSession).not.toHaveBeenCalled();
  });
});
