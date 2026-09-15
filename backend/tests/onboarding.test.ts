import mongoose from 'mongoose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingProvider, SendResult, SessionStatus } from '@scalivo/shared';
import { SESSION_INTENT, SESSION_STATUS, SETUP_STEP, type SetupStepId } from '@scalivo/shared';
import { Business } from '../src/models/Business.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { workingHoursSchema } from '../src/catalog/hours.js';
import { setupChecklist } from '../src/onboarding/readiness.js';
import { provisionSession } from '../src/onboarding/provision.js';
import { loadContext } from '../src/bookings/availability.js';
import { infraReady } from './infra.js';

/**
 * Onboarding — getting a registered business to the point where it can take a
 * booking.
 *
 * Almost every test here is about a SILENT failure. Bad hours, an uncovered
 * service and a retired one all produce an empty availability list, which is
 * byte-identical to a fully booked day. There is no exception to catch and no
 * log line to read, so the only way these stay fixed is a test that asserts the
 * refusal rather than the happy path.
 *
 * The hours block needs no infrastructure. The rest needs Mongo:
 * `docker compose up -d mongo redis`.
 */

const MONDAY = 1;
const TUESDAY = 2;

/** Records what was called and in what order — the provisioning tests need both. */
class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  calls: string[] = [];
  sessionId = 'provisioned-session-1';
  status: SessionStatus = SESSION_STATUS.QR_READY;
  failWebhook = false;
  failCreate = false;
  webhookUrl: string | null = null;

  async sendText(): Promise<SendResult> {
    return { providerMessageId: 'm1', acceptedAt: new Date() };
  }
  async getSessionStatus() {
    return this.status;
  }
  async provisionSession() {
    this.calls.push('create');
    if (this.failCreate) throw new Error('gateway down');
    return { sessionId: this.sessionId, status: SESSION_STATUS.CREATED };
  }
  async registerWebhook(_sessionId: string, url: string) {
    this.calls.push('webhook');
    if (this.failWebhook) throw new Error('SSRF protection rejected the host');
    this.webhookUrl = url;
  }
  async startSession() {
    this.calls.push('start');
    return this.status === SESSION_STATUS.QR_READY
      ? { status: this.status, qrCode: 'data:image/png;base64,xxx' }
      : { status: this.status };
  }
  async getSessionPhone() {
    return '923209263011';
  }
  async resolveContactPhone() {
    return null;
  }
  parseWebhook() {
    return [];
  }
}

// ── Working hours: pure, and the three rules that fail silently ────────────

describe('working hours validation', () => {
  const day = (over: Record<string, unknown> = {}) => ({
    dayOfWeek: MONDAY,
    opensAt: '09:00',
    closesAt: '18:00',
    breaks: [],
    ...over,
  });

  it('accepts an ordinary week', () => {
    const parsed = workingHoursSchema.safeParse([
      day(),
      day({ dayOfWeek: TUESDAY, breaks: [{ startsAt: '13:00', endsAt: '14:00' }] }),
    ]);
    expect(parsed.success).toBe(true);
  });

  /**
   * THE one. getAvailability resolves opensAt and closesAt against the same
   * calendar date, so closes < opens makes the grid loop run zero times. The
   * owner sets 22:00–02:00, sees no bookings ever, and nothing anywhere says
   * why.
   */
  it('refuses hours that cross midnight rather than silently yielding no slots', () => {
    const parsed = workingHoursSchema.safeParse([day({ opensAt: '22:00', closesAt: '02:00' })]);
    expect(parsed.success).toBe(false);
  });

  it('refuses a zero-length day', () => {
    expect(workingHoursSchema.safeParse([day({ closesAt: '09:00' })]).success).toBe(false);
  });

  /**
   * Availability reads hours with `.find()`, so a second Monday is never looked
   * at — and it is the owner's LATER edit that disappears, which is the worse
   * half of the bug.
   */
  it('refuses the same day listed twice', () => {
    const parsed = workingHoursSchema.safeParse([day(), day({ opensAt: '10:00' })]);
    expect(parsed.success).toBe(false);
  });

  it('refuses a break outside opening hours', () => {
    const parsed = workingHoursSchema.safeParse([
      day({ breaks: [{ startsAt: '19:00', endsAt: '20:00' }] }),
    ]);
    expect(parsed.success).toBe(false);
  });

  it('refuses overlapping breaks', () => {
    const parsed = workingHoursSchema.safeParse([
      day({
        breaks: [
          { startsAt: '13:00', endsAt: '14:00' },
          { startsAt: '13:30', endsAt: '15:00' },
        ],
      }),
    ]);
    expect(parsed.success).toBe(false);
  });

  it('refuses a malformed time', () => {
    expect(workingHoursSchema.safeParse([day({ opensAt: '9am' })]).success).toBe(false);
    expect(workingHoursSchema.safeParse([day({ opensAt: '25:00' })]).success).toBe(false);
  });
});


const infraUp = await infraReady();

describe.skipIf(!infraUp)('onboarding', () => {
  let businessId: string;
  let provider: FakeProvider;

  const business = () => Business.findById(businessId);
  const checklist = () => setupChecklist(businessId);
  const stepFor = async (id: SetupStepId) =>
    (await checklist()).steps.find((s) => s.id === id)!;

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    provider = new FakeProvider();

    const doc = await Business.findOneAndUpdate(
      { slug: 'onboarding-test' },
      {
        slug: 'onboarding-test',
        name: 'Onboarding Test Salon',
        category: 'salon',
        timezone: 'Asia/Karachi',
        // A freshly registered business: no session at all, not a stopped one.
        whatsapp: { sessionId: null, intent: SESSION_INTENT.STOPPED, phone: null },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(doc._id);

    await Promise.all([
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      SlotOccupancy.deleteMany({ businessId }),
    ]);
  });

  // ── The checklist ────────────────────────────────────────────────────────

  describe('setup checklist', () => {
    it('reports a freshly registered business as unbookable', async () => {
      const result = await checklist();

      expect(result.bookable).toBe(false);
      // Coverage is excluded: it is vacuously satisfied with no services, which
      // is the point of the "no services at all" test below.
      expect(
        result.steps.filter((s) => s.id !== SETUP_STEP.COVERAGE).every((s) => !s.done),
      ).toBe(true);
      // Every unfinished step says what to do about it.
      expect(result.steps.filter((s) => !s.done).every((s) => s.detail)).toBe(true);
    });

    it('counts a service once it exists', async () => {
      await Service.create({
        businessId,
        name: 'Hydrafacial',
        durationMinutes: 45,
        priceMinor: 800000,
      });
      expect((await stepFor(SETUP_STEP.SERVICES)).done).toBe(true);
    });

    it('does not count staff with no working hours as hours', async () => {
      await Staff.create({ businessId, name: 'Ayesha', workingHours: [] });

      // Someone exists, but nobody has a bookable minute.
      expect((await stepFor(SETUP_STEP.STAFF)).done).toBe(true);
      expect((await stepFor(SETUP_STEP.HOURS)).done).toBe(false);
    });

    /**
     * THE test in this file.
     *
     * Services, staff and hours all pass. Availability still returns nothing,
     * forever, because it filters staff by `serviceIds: serviceId` and finds
     * none. The service appears in the WhatsApp menu, the customer picks it,
     * and the bot says there are no times — which reads as "fully booked", not
     * as a configuration error. Coverage is the only thing that can tell them
     * apart.
     */
    it('catches a service nobody is qualified to perform', async () => {
      await Service.create({
        businessId,
        name: 'Laser',
        durationMinutes: 30,
        priceMinor: 500000,
      });
      await Staff.create({
        businessId,
        name: 'Ayesha',
        serviceIds: [], // qualified for nothing
        workingHours: [{ dayOfWeek: MONDAY, opensAt: '09:00', closesAt: '18:00', breaks: [] }],
      });

      const result = await checklist();
      expect(result.steps.find((s) => s.id === SETUP_STEP.SERVICES)?.done).toBe(true);
      expect(result.steps.find((s) => s.id === SETUP_STEP.STAFF)?.done).toBe(true);
      expect(result.steps.find((s) => s.id === SETUP_STEP.HOURS)?.done).toBe(true);

      const coverage = result.steps.find((s) => s.id === SETUP_STEP.COVERAGE);
      expect(coverage?.done).toBe(false);
      // Names the service, because "something is uncovered" is not actionable.
      expect(coverage?.detail).toContain('Laser');
      expect(result.bookable).toBe(false);
    });

    it('treats a service covered only by someone with no hours as uncovered', async () => {
      const service = await Service.create({
        businessId,
        name: 'Facial',
        durationMinutes: 30,
        priceMinor: 500000,
      });
      await Staff.create({
        businessId,
        name: 'Ayesha',
        serviceIds: [String(service._id)],
        workingHours: [], // qualified, but never working
      });

      expect((await stepFor(SETUP_STEP.COVERAGE)).done).toBe(false);
    });

    it('does not report coverage separately when there are no services at all', async () => {
      // One gap, one complaint. Reporting the same missing thing twice reads as
      // two problems and makes the list look longer than the work.
      expect((await stepFor(SETUP_STEP.COVERAGE)).done).toBe(true);
      expect((await stepFor(SETUP_STEP.SERVICES)).done).toBe(false);
    });

    it('ignores retired services and deactivated staff', async () => {
      await Service.create({
        businessId,
        name: 'Retired',
        durationMinutes: 30,
        priceMinor: 100,
        active: false,
      });
      await Staff.create({ businessId, name: 'Gone', active: false, workingHours: [] });

      const result = await checklist();
      expect(result.steps.find((s) => s.id === SETUP_STEP.SERVICES)?.done).toBe(false);
      expect(result.steps.find((s) => s.id === SETUP_STEP.STAFF)?.done).toBe(false);
    });

    it('is bookable only once WhatsApp is actually ready', async () => {
      const service = await Service.create({
        businessId,
        name: 'Hydrafacial',
        durationMinutes: 45,
        priceMinor: 800000,
      });
      await Staff.create({
        businessId,
        name: 'Ayesha',
        serviceIds: [String(service._id)],
        workingHours: [{ dayOfWeek: MONDAY, opensAt: '09:00', closesAt: '18:00', breaks: [] }],
      });

      // A session that exists but has not been scanned is not a connection.
      await Business.updateOne(
        { _id: businessId },
        { $set: { 'whatsapp.sessionId': 's1', 'whatsapp.status': SESSION_STATUS.QR_READY } },
      );
      expect((await checklist()).bookable).toBe(false);
      expect((await stepFor(SETUP_STEP.WHATSAPP)).detail).toContain('Scan');

      await Business.updateOne(
        { _id: businessId },
        { $set: { 'whatsapp.status': SESSION_STATUS.READY } },
      );
      expect((await checklist()).bookable).toBe(true);
    });
  });

  // ── Provisioning ─────────────────────────────────────────────────────────

  describe('session provisioning', () => {
    /**
     * Ordering, not just outcome. The gateway starts emitting the moment a
     * session starts, and `session.authenticated` — the event that proves the
     * owner's scan worked — is emitted into nothing if the webhook is not
     * registered first.
     */
    it('registers the webhook before starting the session', async () => {
      const result = await provisionSession({ provider }, businessId);

      expect(result.ok).toBe(true);
      expect(provider.calls).toEqual(['create', 'webhook', 'start']);
      expect(provider.webhookUrl).toContain('/webhooks/whatsapp');
    });

    it('records the session and returns the QR', async () => {
      const result = await provisionSession({ provider }, businessId);

      expect(result).toMatchObject({ ok: true, sessionId: 'provisioned-session-1' });
      const after = await business();
      expect(after?.whatsapp?.sessionId).toBe('provisioned-session-1');
      expect(after?.whatsapp?.intent).toBe(SESSION_INTENT.LINKING);
    });

    /**
     * A session is a ~90 MB Chromium profile and the measured ceiling is about
     * two per instance. A retry that created a second one would strand the
     * first: running, eating another business's whole RAM budget, reachable by
     * nobody.
     */
    it('resumes rather than creating a second session when a retry follows a failure', async () => {
      provider.failWebhook = true;
      const first = await provisionSession({ provider }, businessId);
      expect(first).toMatchObject({ ok: false, reason: 'webhook_rejected' });

      // The id survived the failure — that is what makes the retry a resume.
      expect((await business())?.whatsapp?.sessionId).toBe('provisioned-session-1');

      provider.failWebhook = false;
      provider.calls = [];
      const second = await provisionSession({ provider }, businessId);

      expect(second.ok).toBe(true);
      expect(provider.calls).toEqual(['webhook', 'start']);
      expect(provider.calls).not.toContain('create');
    });

    /**
     * While intent is LINKING, Session Health treats every QR and every
     * disconnect as expected and stays silent. A failed attempt left in LINKING
     * would disarm the outage alarm for that business indefinitely.
     */
    it('leaves a failed attempt STOPPED, not LINKING, so the alarm stays armed', async () => {
      provider.failCreate = true;

      const result = await provisionSession({ provider }, businessId);

      expect(result).toMatchObject({ ok: false, reason: 'gateway_unreachable' });
      expect((await business())?.whatsapp?.intent).toBe(SESSION_INTENT.STOPPED);
    });

    it('does not start a session whose webhook was rejected', async () => {
      provider.failWebhook = true;

      await provisionSession({ provider }, businessId);

      // A started session with no webhook delivers nothing and looks fine.
      expect(provider.calls).not.toContain('start');
    });

    it('refuses to replace a live session without force', async () => {
      provider.status = SESSION_STATUS.READY;
      await provisionSession({ provider }, businessId);
      await Business.updateOne(
        { _id: businessId },
        { $set: { 'whatsapp.status': SESSION_STATUS.READY } },
      );

      // Re-linking logs the owner's phone out of a working number. A stray tap
      // on Connect must not do that.
      const again = await provisionSession({ provider }, businessId);
      expect(again).toMatchObject({ ok: false, reason: 'already_linked' });
    });

    it('flips intent to LIVE when the session came back already authenticated', async () => {
      // Spike proof #9: a container restart recovers with zero session.qr, so
      // there is nothing to scan and nothing to wait for.
      provider.status = SESSION_STATUS.READY;

      const result = await provisionSession({ provider }, businessId);

      expect(result).toMatchObject({ ok: true, qrCode: null });
      expect((await business())?.whatsapp?.intent).toBe(SESSION_INTENT.LIVE);
    });
  });

  // ── Retiring ─────────────────────────────────────────────────────────────

  describe('retiring a service', () => {
    it('makes it unbookable through the one gate every booking path shares', async () => {
      const service = await Service.create({
        businessId,
        name: 'Discontinued',
        durationMinutes: 30,
        priceMinor: 500000,
      });

      expect(await loadContext(businessId, String(service._id))).not.toBeNull();

      await Service.updateOne({ _id: service._id }, { $set: { active: false } });

      // loadContext is what holdSlot and createBooking both call first, so a
      // null here is the whole booking path closing at once.
      expect(await loadContext(businessId, String(service._id))).toBeNull();
    });
  });
});
