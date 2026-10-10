'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MeAppointment, MeUsual, PublicSlot } from '@scalivo/shared';
import { API_BASE } from '@/lib/site';
import { formatWhen, formatClock } from '@/lib/format';
import { WhatsAppVerification } from '../WhatsAppVerification';
import { Rebook } from './Rebook';

type Holder = { id: string; name: string };

export function CustomerBookingTools({
  token,
  appointments,
  usual,
  timezone,
  businessSlug,
}: {
  token: string;
  appointments: MeAppointment[];
  usual: MeUsual | null;
  timezone: string;
  businessSlug: string;
}) {
  const router = useRouter();
  const [proof, setProof] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [moving, setMoving] = useState<MeAppointment | null>(null);
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<PublicSlot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [holders, setHolders] = useState<Holder[]>([]);
  const [holderId, setHolderId] = useState('');
  const [holderName, setHolderName] = useState('');
  const version = useRef(0);
  const base = `${API_BASE}/public/me/${encodeURIComponent(token)}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${base}/holders`, {
      cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data) => {
        if (!controller.signal.aborted && Array.isArray(data.holders) && data.holders.length <= 20)
          setHolders(data.holders);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Could not load family members. Refresh to try again.');
      });
    return () => controller.abort();
  }, [base]);
  useEffect(() => {
    const current = ++version.current;
    if (!moving || !date) {
      setSlots(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setSlots(null);
    void fetch(`${base}/bookings/${moving.id}/availability?${new URLSearchParams({ date })}`, {
      cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error();
        return data;
      })
      .then((data) => {
        if (version.current === current && !controller.signal.aborted) setSlots(data.slots);
      })
      .catch(() => {
        if (version.current === current && !controller.signal.aborted)
          setError('Could not load available times. Choose another date or try again.');
      })
      .finally(() => {
        if (version.current === current && !controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [moving, date, base]);
  async function mutate(
    path: string,
    body: object,
    success: string,
    method: 'POST' | 'PATCH' = 'POST',
  ) {
    if (busy || !proof) return null;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        signal: AbortSignal.timeout(15000),
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, verificationProof: proof }),
      });
      const data = response.status === 204 ? {} : await response.json();
      if (!response.ok) {
        if (response.status === 401 && data.reason === 'verification_required') setProof(null);
        setError(data.error ?? 'The appointment could not be changed.');
        return null;
      }
      setNotice(success);
      router.refresh();
      return data;
    } catch {
      setError('Could not connect. Refresh your appointments before retrying.');
      return null;
    } finally {
      setBusy(false);
    }
  }
  const button =
    'min-h-11 rounded-lg border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50';
  return (
    <section className="mt-8 space-y-5" aria-label="Manage appointments">
      <h2 className="text-lg font-semibold">Book and manage appointments</h2>
      {!proof ? (
        <WhatsAppVerification
          path={`/public/me/${encodeURIComponent(token)}`}
          phoneRequired={false}
          onVerified={(value) => {
            setProof(value);
            setError(null);
          }}
        />
      ) : (
        <p className="text-sm text-muted">WhatsApp verified for this session.</p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg bg-surface p-3 text-sm">
          {notice}
        </p>
      )}
      {proof && (
        <>
          {appointments.map((appointment) => (
            <div key={appointment.id} className="rounded-xl border border-line p-4">
              <p className="font-semibold">
                {appointment.serviceName}
                {appointment.appointmentHolderName
                  ? ` for ${appointment.appointmentHolderName}`
                  : ''}
              </p>
              <p className="mb-3 text-sm text-muted">
                {formatWhen(appointment.startsAt, timezone)}
                {appointment.status === 'awaiting_approval' ? ' · Awaiting owner approval' : ''}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={button}
                  onClick={() => {
                    setMoving(appointment);
                    setDate('');
                    setSlots(null);
                    setError(null);
                  }}
                >
                  Change time
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={button}
                  onClick={async () => {
                    if (window.confirm('Cancel this appointment? Its time will be released.'))
                      await mutate(
                        `/bookings/${appointment.id}/cancel`,
                        {},
                        'Appointment cancelled.',
                      );
                  }}
                >
                  Cancel appointment
                </button>
              </div>
            </div>
          ))}
          {moving && (
            <div className="space-y-3 rounded-xl border border-line p-4">
              <h3 className="font-semibold">Choose a new date for {moving.serviceName}</h3>
              <label className="grid gap-1 text-sm">
                Date
                <input
                  type="date"
                  value={date}
                  disabled={busy}
                  onChange={(event) => setDate(event.target.value)}
                  className="min-h-12 rounded-lg border border-line px-3"
                />
              </label>
              {loading && <p role="status">Loading times…</p>}
              {slots?.length === 0 && <p>No times available on this day. Choose another date.</p>}
              <div className="flex flex-wrap gap-2">
                {slots?.map((slot) => (
                  <button
                    key={slot.startsAt}
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={async () => {
                      if (!window.confirm(`Move to ${formatWhen(slot.startsAt, timezone)}?`))
                        return;
                      const result = await mutate(
                        `/bookings/${moving.id}/reschedule`,
                        { startsAt: slot.startsAt },
                        'Appointment moved.',
                      );
                      if (result) setMoving(null);
                    }}
                  >
                    {formatClock(slot.startsAt, timezone)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => setMoving(null)}
              >
                Keep current time
              </button>
            </div>
          )}
          <div className="space-y-3 rounded-xl border border-line p-4">
            <h3 className="font-semibold">Appointment for</h3>
            <label className="grid gap-1 text-sm">
              Person
              <select
                value={holderId}
                onChange={(event) => setHolderId(event.target.value)}
                className="min-h-12 rounded-lg border border-line px-3"
              >
                <option value="">Myself</option>
                {holders.map((holder) => (
                  <option key={holder.id} value={holder.id}>
                    {holder.name}
                  </option>
                ))}
              </select>
            </label>
            {holderId && (
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={button}
                  onClick={async () => {
                    const current = holders.find((holder) => holder.id === holderId);
                    const name = window
                      .prompt('New name for this appointment holder', current?.name ?? '')
                      ?.trim();
                    if (!name || name.length > 80) return;
                    const saved = await mutate(
                      `/holders/${holderId}`,
                      { name },
                      'Name updated.',
                      'PATCH',
                    );
                    if (saved?.id)
                      setHolders((items) =>
                        items.map((item) => (item.id === saved.id ? saved : item)),
                      );
                  }}
                >
                  Edit person
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={button}
                  onClick={async () => {
                    const current = holders.find((holder) => holder.id === holderId);
                    if (
                      !current ||
                      !window.confirm(
                        `Remove ${current.name}? Future appointments must be moved or cancelled first.`,
                      )
                    )
                      return;
                    const saved = await mutate(
                      `/holders/${holderId}`,
                      { name: current.name, active: false },
                      'Person removed.',
                      'PATCH',
                    );
                    if (saved?.id) {
                      setHolders((items) => items.filter((item) => item.id !== saved.id));
                      setHolderId('');
                    }
                  }}
                >
                  Remove person
                </button>
              </div>
            )}
            <label className="grid gap-1 text-sm">
              Add a family member
              <input
                value={holderName}
                maxLength={80}
                onChange={(event) => setHolderName(event.target.value)}
                className="min-h-12 rounded-lg border border-line px-3"
              />
            </label>
            <button
              type="button"
              className={button}
              disabled={busy || !holderName.trim() || holders.length >= 20}
              onClick={async () => {
                const holder = await mutate(
                  '/holders',
                  { name: holderName.trim() },
                  'Family member added.',
                );
                if (holder?.id) {
                  setHolders((current) => [...current, holder]);
                  setHolderName('');
                  setHolderId(holder.id);
                }
              }}
            >
              Add person
            </button>
          </div>
          <Rebook
            token={token}
            usual={usual}
            timezone={timezone}
            businessSlug={businessSlug}
            verificationProof={proof}
            appointmentHolderId={holderId || undefined}
          />
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={async () => {
              if (
                !window.confirm(
                  'Replace your private link? The previous link and installed shortcut will stop working. Save the new link.',
                )
              )
                return;
              const data = await mutate('/revoke', {}, 'Private link replaced.');
              if (data?.customerToken)
                router.replace(`/me/${encodeURIComponent(data.customerToken)}`);
            }}
          >
            Replace private link
          </button>
        </>
      )}
    </section>
  );
}
