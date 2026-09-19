'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  PublicBookingReceipt,
  PublicHold,
  PublicService,
  PublicSlot,
  PublicStaff,
} from '@scalivo/shared';

import { ArrowLeft, ArrowRight, CheckIcon, ChatIcon } from '@/components/Icons';
import { formatDuration, formatPrice } from '@/lib/format';
import { API_BASE } from '@/lib/site';

/**
 * Web booking: service → professional → day → time → your details.
 *
 * Deliberately thin. Every rule that matters — what is bookable, who gets the
 * slot when two people tap at once — lives in the backend, behind the same
 * hold and occupancy transaction WhatsApp uses. This component only asks, and
 * shows the answer. It never decides a time is free; it asks for times that are.
 *
 * Nothing is stored in the browser. A reload starts again, and any hold it had
 * simply runs out after two minutes.
 */

const ANY = 'any';
/** How many days the date strip offers, capped by the business's own horizon. */
const DAYS_SHOWN = 14;

interface Props {
  slug: string;
  businessName: string;
  timezone: string;
  bookingHorizonDays: number;
  services: PublicService[];
  staff: PublicStaff[];
}

type ApiError = { error?: string; reason?: string; fields?: Record<string, string> };

async function call<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; body: ApiError }> {
  try {
    const response = await fetch(`${API_BASE}/public/businesses/${path}`, {
      ...init,
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    });
    if (response.status === 204) return { ok: true, data: undefined as T };
    const body = await response.json().catch(() => ({}));
    return response.ok ? { ok: true, data: body as T } : { ok: false, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: 'Could not reach Scalivo. Check your connection and try again.' } };
  }
}

/** Business-local calendar dates, as 'YYYY-MM-DD', starting today in THEIR zone. */
function upcomingDates(timezone: string, count: number): string[] {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(y!, m! - 1, d! + i)).toISOString().slice(0, 10),
  );
}

/** A calendar date is zone-less — format it in UTC so it never shifts a day. */
const dayParts = (date: string) => {
  const at = new Date(`${date}T00:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(at),
    day: new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'UTC' }).format(at),
    long: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at),
  };
};

export function BookingFlow({ slug, businessName, timezone, bookingHorizonDays, services, staff }: Props) {
  const sectionRef = useRef<HTMLDivElement>(null);

  const [serviceId, setServiceId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string>(ANY);
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<PublicSlot[] | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [hold, setHold] = useState<PublicHold | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PublicBookingReceipt | null>(null);

  const service = services.find((s) => s.id === serviceId) ?? null;
  const qualified = useMemo(
    () => (serviceId ? staff.filter((member) => member.serviceIds.includes(serviceId)) : []),
    [serviceId, staff],
  );
  const staffName = (id: string) => staff.find((member) => member.id === id)?.name ?? '';

  const timeLabel = useMemo(
    () => new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }),
    [timezone],
  );

  /* Dates depend on "today" in the business's zone — computed after mount so a
     statically rendered page never bakes in its build day. */
  useEffect(() => {
    const list = upcomingDates(timezone, Math.min(DAYS_SHOWN, bookingHorizonDays + 1));
    setDates(list);
    setDate((current) => current ?? list[0] ?? null);
  }, [timezone, bookingHorizonDays]);

  /* "Book" on a service card links to #book=<serviceId>. */
  useEffect(() => {
    const fromHash = () => {
      const match = /^#book(?:=([\w-]+))?$/.exec(window.location.hash);
      if (!match) return;
      if (match[1] && services.some((s) => s.id === match[1])) setServiceId(match[1]);
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [services]);

  /** Give a held time back — the customer moved on from it. Fire and forget. */
  const release = useCallback(
    (current: PublicHold | null, forService: string | null) => {
      if (!current || !forService) return;
      void call(`${slug}/holds/release`, {
        method: 'POST',
        body: JSON.stringify({ token: current.token, serviceId: forService, staffId: current.staffId, startsAt: current.startsAt }),
      });
    },
    [slug],
  );

  const loadSlots = useCallback(async () => {
    if (!serviceId || !date) return;
    setLoadingSlots(true);
    const params = new URLSearchParams({ serviceId, date, staffId });
    const result = await call<{ slots: PublicSlot[] }>(`${slug}/availability?${params}`);
    setLoadingSlots(false);
    if (result.ok) {
      setSlots(result.data.slots);
    } else {
      setSlots([]);
      setNotice(result.body.error ?? 'Could not load times.');
    }
  }, [slug, serviceId, date, staffId]);

  useEffect(() => {
    setSlots(null);
    void loadSlots();
  }, [loadSlots]);

  /* Changing what is being booked lets go of any time already held. */
  const holdRef = useRef<{ hold: PublicHold | null; serviceId: string | null }>({ hold: null, serviceId: null });
  holdRef.current = { hold, serviceId };
  const dropHold = useCallback(() => {
    release(holdRef.current.hold, holdRef.current.serviceId);
    setHold(null);
  }, [release]);

  /* The countdown. When it hits zero the server has already let go. */
  useEffect(() => {
    if (!hold) return;
    const tick = () => {
      const left = Math.max(0, Math.round((new Date(hold.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) {
        setHold(null);
        setNotice('Your time was only held for two minutes. Pick it again to continue.');
        void loadSlots();
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [hold, loadSlots]);

  function chooseService(id: string) {
    if (id === serviceId) return;
    dropHold();
    setNotice(null);
    setServiceId(id);
    // Keep a chosen professional only if they can do the new service too.
    const stillQualified = staff.some((m) => m.id === staffId && m.serviceIds.includes(id));
    if (!stillQualified) setStaffId(ANY);
  }

  function chooseStaff(id: string) {
    dropHold();
    setNotice(null);
    setStaffId(id);
  }

  function chooseDate(next: string) {
    dropHold();
    setNotice(null);
    setDate(next);
  }

  async function chooseTime(slot: PublicSlot) {
    if (!serviceId || holding) return;
    dropHold();
    setNotice(null);
    setHolding(slot.startsAt);

    const result = await call<PublicHold>(`${slug}/holds`, {
      method: 'POST',
      // Ask for the person availability offered, not "anyone": that is the
      // offer the customer is looking at.
      body: JSON.stringify({ serviceId, staffId: slot.staffId, startsAt: slot.startsAt }),
    });
    setHolding(null);

    if (result.ok) {
      setHold(result.data);
      return;
    }
    setNotice(result.body.error ?? 'That time could not be held.');
    void loadSlots();
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!hold || !serviceId || submitting) return;
    setSubmitting(true);
    setFields({});
    setNotice(null);

    const result = await call<PublicBookingReceipt>(`${slug}/bookings`, {
      method: 'POST',
      body: JSON.stringify({
        serviceId,
        staffId: hold.staffId,
        startsAt: hold.startsAt,
        holdToken: hold.token,
        name,
        phone,
      }),
    });
    setSubmitting(false);

    if (result.ok) {
      setHold(null);
      setReceipt(result.data);
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    setNotice(result.body.error ?? 'The booking did not go through. Try again.');
    if (result.body.fields) setFields(result.body.fields);
    if (result.body.reason === 'invalid_phone') setFields({ phone: result.body.error ?? '' });
    // The world moved: the time is gone or no longer ours. Show what is left.
    if (result.body.reason === 'slot_taken' || result.body.reason === 'hold_expired') {
      setHold(null);
      void loadSlots();
    }
  }

  function startOver() {
    setReceipt(null);
    setServiceId(null);
    setStaffId(ANY);
    setName('');
    setPhone('');
    setNotice(null);
  }

  /* -------------------------------------------------------------- render */

  if (receipt) {
    return (
      <div ref={sectionRef} className="scroll-mt-6 rounded-2xl border border-line p-6 md:p-8" aria-live="polite">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-open text-white">
          <CheckIcon className="h-6 w-6" />
        </span>
        <h3 className="mt-5 text-[24px] font-bold tracking-[-0.02em]">You&rsquo;re booked</h3>
        <p className="mt-1 text-[15px] text-muted">at {businessName}</p>
        <dl className="mt-6 grid gap-3 text-[15px] sm:grid-cols-2">
          <Row label="Service" value={receipt.serviceName} />
          <Row label="With" value={receipt.staffName} />
          <Row
            label="When"
            value={`${new Intl.DateTimeFormat('en-GB', {
              timeZone: timezone,
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            }).format(new Date(receipt.startsAt))} at ${timeLabel.format(new Date(receipt.startsAt))}`}
          />
          <Row label="Price" value={formatPrice(receipt.priceMinor)} />
        </dl>
        <p className="mt-6 flex items-start gap-2 text-[15px]">
          <ChatIcon className="mt-0.5 h-5 w-5 shrink-0" />
          <span>
            We&rsquo;re sending the confirmation to your WhatsApp. Reply to it to cancel or change the time.
          </span>
        </p>
        <button type="button" onClick={startOver} className="mt-6 text-[15px] font-semibold text-brand hover:underline">
          Book something else
        </button>
      </div>
    );
  }

  return (
    <div ref={sectionRef} className="scroll-mt-6 space-y-8">
      {/* 1 · Service */}
      <Step number={1} title="Choose a service">
        <ul className="space-y-2">
          {services.map((option) => {
            const selected = option.id === serviceId;
            return (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => chooseService(option.id)}
                  aria-pressed={selected}
                  className={`flex w-full items-center justify-between gap-4 rounded-lg border px-4 py-3 text-left transition-colors ${
                    selected ? 'border-ink bg-surface' : 'border-line hover:bg-surface/60'
                  }`}
                >
                  <span>
                    <span className="block text-[15px] font-semibold">{option.name}</span>
                    <span className="text-[14px] text-muted">{formatDuration(option.durationMinutes)}</span>
                  </span>
                  <span className="flex items-center gap-3 text-[15px] font-semibold">
                    {option.priceMinor === 0 ? 'Free' : formatPrice(option.priceMinor)}
                    <span
                      aria-hidden="true"
                      className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                        selected ? 'border-ink bg-ink text-white' : 'border-line'
                      }`}
                    >
                      {selected ? <CheckIcon className="h-3 w-3" /> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Step>

      {service ? (
        <>
          {/* 2 · Professional */}
          {qualified.length > 1 ? (
            <Step number={2} title="Choose a professional">
              <div className="flex flex-wrap gap-2">
                <Chip selected={staffId === ANY} onClick={() => chooseStaff(ANY)}>
                  Any professional
                </Chip>
                {qualified.map((member) => (
                  <Chip key={member.id} selected={staffId === member.id} onClick={() => chooseStaff(member.id)}>
                    {member.name}
                  </Chip>
                ))}
              </div>
            </Step>
          ) : null}

          {/* 3 · Time */}
          <Step number={qualified.length > 1 ? 3 : 2} title="Pick a time">
            <DateStrip dates={dates} selected={date} onSelect={chooseDate} />

            <div className="mt-5 min-h-[120px]" aria-live="polite" aria-busy={loadingSlots}>
              {slots === null || loadingSlots ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-hidden="true">
                  {Array.from({ length: 8 }, (_, i) => (
                    <span key={i} className="h-11 animate-pulse rounded-lg bg-surface" />
                  ))}
                </div>
              ) : slots.length === 0 ? (
                <div className="rounded-lg bg-surface px-5 py-6 text-center">
                  <p className="text-[15px] font-semibold">No times left {date ? `on ${dayParts(date).long}` : ''}</p>
                  {date && dates.indexOf(date) < dates.length - 1 ? (
                    <button
                      type="button"
                      onClick={() => chooseDate(dates[dates.indexOf(date) + 1]!)}
                      className="mt-3 inline-flex items-center gap-1.5 text-[15px] font-semibold text-brand hover:underline"
                    >
                      Try the next day <ArrowRight className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              ) : (
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {slots.map((slot) => {
                    const selected = hold?.startsAt === slot.startsAt;
                    return (
                      <li key={slot.startsAt}>
                        <button
                          type="button"
                          onClick={() => chooseTime(slot)}
                          disabled={holding !== null}
                          aria-pressed={selected}
                          className={`h-11 w-full rounded-lg border text-[15px] font-semibold transition-colors disabled:opacity-60 ${
                            selected ? 'border-ink bg-ink text-white' : 'border-line hover:bg-surface'
                          }`}
                        >
                          {holding === slot.startsAt ? 'Holding…' : timeLabel.format(new Date(slot.startsAt))}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Step>

          {notice ? (
            <p role="alert" className="rounded-lg bg-[#fff4e5] px-4 py-3 text-[15px]">
              {notice}
            </p>
          ) : null}

          {/* 4 · Details */}
          {hold ? (
            <Step number={qualified.length > 1 ? 4 : 3} title="Your details">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface px-4 py-3 text-[15px]">
                <span>
                  <span className="font-semibold">{service.name}</span> with {staffName(hold.staffId)},{' '}
                  {date ? dayParts(date).long : ''} at {timeLabel.format(new Date(hold.startsAt))}
                </span>
                <span className="text-[14px] text-muted" aria-live="off">
                  Held for {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
                </span>
              </div>

              <form onSubmit={confirm} noValidate className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="book-name"
                  label="Your name"
                  value={name}
                  onChange={setName}
                  autoComplete="name"
                  error={fields.name}
                />
                <Field
                  id="book-phone"
                  label="WhatsApp number"
                  value={phone}
                  onChange={setPhone}
                  autoComplete="tel"
                  inputMode="tel"
                  placeholder="0300 1234567"
                  hint="Your confirmation and reminder arrive here."
                  error={fields.phone}
                />
                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex h-12 w-full items-center justify-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white transition-colors hover:bg-black/80 disabled:opacity-60 sm:w-auto"
                  >
                    {submitting ? 'Booking…' : service.priceMinor === 0 ? 'Confirm booking' : `Confirm booking · ${formatPrice(service.priceMinor)}`}
                  </button>
                  <p className="mt-3 text-[13px] text-muted">No account needed. Nothing is charged online.</p>
                </div>
              </form>
            </Step>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-4 flex items-center gap-3 text-[18px] font-bold tracking-[-0.01em]">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-[14px] text-white">{number}</span>
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Chip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-full border px-4 py-2 text-[15px] font-semibold transition-colors ${
        selected ? 'border-ink bg-ink text-white' : 'border-line hover:bg-surface'
      }`}
    >
      {children}
    </button>
  );
}

function DateStrip({ dates, selected, onSelect }: { dates: string[]; selected: string | null; onSelect: (date: string) => void }) {
  const track = useRef<HTMLUListElement>(null);
  const scroll = (direction: 1 | -1) => track.current?.scrollBy({ left: direction * 240, behavior: 'smooth' });

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => scroll(-1)}
        aria-label="Earlier dates"
        className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line hover:bg-surface sm:flex"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <ul ref={track} className="no-scrollbar flex min-w-0 flex-1 gap-2 overflow-x-auto scroll-smooth">
        {dates.map((date) => {
          const { weekday, day, long } = dayParts(date);
          const active = date === selected;
          return (
            <li key={date} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(date)}
                aria-pressed={active}
                aria-label={long}
                className={`flex h-[68px] w-14 flex-col items-center justify-center rounded-xl border transition-colors ${
                  active ? 'border-brand bg-brand text-white' : 'border-line hover:bg-surface'
                }`}
              >
                <span className="text-[20px] font-bold leading-none">{day}</span>
                <span className={`mt-1 text-[12px] ${active ? 'text-white/85' : 'text-muted'}`}>{weekday}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => scroll(1)}
        aria-label="Later dates"
        className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line hover:bg-surface sm:flex"
      >
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  inputMode?: 'tel';
  placeholder?: string;
  hint?: string;
  error?: string | undefined;
}) {
  const describedBy = [props.hint ? `${props.id}-hint` : null, props.error ? `${props.id}-error` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div>
      <label htmlFor={props.id} className="block text-[14px] font-semibold">
        {props.label}
      </label>
      <input
        id={props.id}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        placeholder={props.placeholder}
        required
        aria-invalid={Boolean(props.error)}
        aria-describedby={describedBy || undefined}
        className={`mt-1.5 h-12 w-full rounded-lg border px-4 text-[16px] outline-none focus:border-ink ${
          props.error ? 'border-[#d92d20]' : 'border-line'
        }`}
      />
      {props.hint ? (
        <p id={`${props.id}-hint`} className="mt-1.5 text-[13px] text-muted">
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p id={`${props.id}-error`} className="mt-1.5 text-[13px] font-medium text-[#d92d20]">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
