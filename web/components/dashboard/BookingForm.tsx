'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { Service, Staff, Client, AvailableSlot, SequenceSlot } from '@scalivo/shared';
import {
  getAvailabilityAction,
  createBookingAction,
  getSequenceAvailabilityAction,
  getAppointmentHoldersAction,
} from '@/lib/actions/booking';

interface BookingFormProps {
  businessId: string;
  timezone: string;
  services: Service[];
  staff: Staff[];
  clients: Client[];
  onSuccess: () => void;
}

export function BookingForm({
  businessId,
  timezone,
  services,
  staff,
  clients,
  onSuccess,
}: BookingFormProps) {
  const router = useRouter();
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('any');
  const [clientId, setClientId] = useState('');
  const [holderId, setHolderId] = useState('');
  const [holders, setHolders] = useState<{ id: string; name: string }[]>([]);
  const [holderError, setHolderError] = useState(false);
  const [extra, setExtra] = useState<{ serviceId: string; staffId: string }[]>([]);
  const requestId = useRef<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sequenceSlots, setSequenceSlots] = useState<SequenceSlot[]>([]);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  useEffect(() => {
    requestId.current = null;
  }, [serviceId, staffId, clientId, holderId, extra]);
  useEffect(() => {
    let active = true;
    setHolders([]);
    setHolderId('');
    setHolderError(false);
    if (clientId)
      void getAppointmentHoldersAction(businessId, clientId)
        .then((result) => {
          if (active) setHolders(result.holders);
        })
        .catch(() => {
          if (active) setHolderError(true);
        });
    return () => {
      active = false;
    };
  }, [businessId, clientId]);

  // Date defaults to today in local time, though it requires proper parsing.
  // Using simple YYYY-MM-DD input.
  const [date, setDate] = useState(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()),
  );
  const [timeStr, setTimeStr] = useState('');

  const [availableSlots, setAvailableSlots] = useState<AvailableSlot[]>([]);
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);

  // Outcome States
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let active = true;

    async function loadSlots() {
      if (!serviceId || !date) {
        setAvailableSlots([]);
        setTimeStr('');
        return;
      }
      setIsLoadingSlots(true);
      setAvailableSlots([]);
      setTimeStr('');
      setGenericError(null);
      try {
        if (extra.length) {
          setSequenceSlots([]);
          if (staffId === 'any' || extra.some((step) => !step.serviceId || !step.staffId)) return;
          const slots = await getSequenceAvailabilityAction(
            businessId,
            [{ serviceId, staffId }, ...extra],
            date!,
          );
          if (active) {
            setSequenceSlots(slots);
            setAvailableSlots(
              slots.map((slot) => ({
                ...slot,
                startsAt: new Date(slot.startsAt),
                durationMinutes:
                  services.find((service) => service.id === serviceId)?.durationMinutes ?? 0,
              })),
            );
          }
          return;
        }
        const slots = await getAvailabilityAction(businessId, serviceId, date, staffId);
        if (active) {
          setAvailableSlots(slots);
        }
      } catch {
        if (active)
          setGenericError('Could not load available times. Change the date or try again.');
      } finally {
        if (active) {
          setIsLoadingSlots(false);
        }
      }
    }

    loadSlots();
    return () => {
      active = false;
    };
  }, [businessId, serviceId, staffId, date, extra, services]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSuccessMessage(null);
    setConflictMessage(null);
    setGenericError(null);
    setValidationErrors({});

    const res = await createBookingAction(businessId, {
      serviceId,
      staffId,
      clientId,
      ...(holderId ? { appointmentHolderId: holderId } : {}),
      ...(extra.length
        ? {
            additionalServices: extra,
            requestId:
              requestId.current ?? (requestId.current = crypto.randomUUID().replaceAll('-', '')),
          }
        : {}),
      startsAt: timeStr,
    });

    setIsSubmitting(false);

    if (res.success) {
      setSuccessMessage('Booking successfully created!');
      // Wait a moment for screen readers to announce, then close
      closeTimer.current = setTimeout(() => {
        router.refresh(); // Tell Next.js Server Components to re-fetch
        onSuccess(); // Close modal
      }, 1500);
    } else {
      if (res.error === 'slot_taken') {
        setConflictMessage('That time was just taken, please pick another.');
      } else if (res.error === 'hold_expired') {
        setConflictMessage('That slot is no longer held for you.');
      } else if (res.error === 'validation' && res.validationErrors) {
        setValidationErrors(res.validationErrors);
      } else {
        setGenericError('Something went wrong. Please try again later.');
      }
    }
  };

  // Helper for displaying validation errors
  const errId = (field: string) => `err-${field}`;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* ARIA Live Region for Announcements */}
      <div aria-live="polite" role="status" className="empty:hidden">
        {successMessage && (
          <div className="p-3 bg-green-50 text-green-700 text-sm rounded-md mb-2">
            {successMessage}
          </div>
        )}
        {conflictMessage && (
          <div className="p-3 bg-orange-50 text-orange-800 text-sm rounded-md mb-2">
            {conflictMessage}
          </div>
        )}
        {genericError && (
          <div className="p-3 bg-red-50 text-red-700 text-sm rounded-md mb-2">{genericError}</div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="serviceId" className="text-[14px] font-semibold text-ink">
          Service
        </label>
        <select
          id="serviceId"
          value={serviceId}
          onChange={(e) => {
            setServiceId(e.target.value);
            setStaffId(extra.length ? '' : 'any');
          }}
          className="h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] outline-none transition-colors hover:border-ink/20 focus:border-ink focus:ring-1 focus:ring-ink"
          required
          aria-invalid={!!validationErrors.serviceId}
          aria-describedby={validationErrors.serviceId ? errId('serviceId') : undefined}
        >
          <option value="" disabled>
            Select a service...
          </option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {validationErrors.serviceId && (
          <span id={errId('serviceId')} className="text-xs text-red-600">
            {validationErrors.serviceId.join(', ')}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="staffId" className="text-[14px] font-semibold text-ink">
          Staff
        </label>
        <select
          id="staffId"
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          className="h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] outline-none transition-colors hover:border-ink/20 focus:border-ink focus:ring-1 focus:ring-ink"
          required
          aria-invalid={!!validationErrors.staffId}
          aria-describedby={validationErrors.staffId ? errId('staffId') : undefined}
        >
          {!extra.length && <option value="any">Any Available Staff</option>}
          {staff
            .filter((s) => !serviceId || s.serviceIds?.includes(serviceId))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        {validationErrors.staffId && (
          <span id={errId('staffId')} className="text-xs text-red-600">
            {validationErrors.staffId.join(', ')}
          </span>
        )}
      </div>

      <div className="space-y-3">
        {extra.map((step, index) => (
          <fieldset key={index} className="space-y-2 rounded-lg border border-line p-3">
            <legend className="text-sm font-semibold">Treatment {index + 2}</legend>
            <label className="grid gap-1 text-sm">
              Service
              <select
                required
                disabled={isSubmitting}
                value={step.serviceId}
                onChange={(event) =>
                  setExtra((items) =>
                    items.map((item, i) =>
                      i === index ? { serviceId: event.target.value, staffId: '' } : item,
                    ),
                  )
                }
                className="min-h-11 rounded-lg border border-line px-3"
              >
                <option value="">Choose service</option>
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Staff
              <select
                required
                disabled={isSubmitting}
                value={step.staffId}
                onChange={(event) =>
                  setExtra((items) =>
                    items.map((item, i) =>
                      i === index ? { ...item, staffId: event.target.value } : item,
                    ),
                  )
                }
                className="min-h-11 rounded-lg border border-line px-3"
              >
                <option value="">Choose staff</option>
                {staff
                  .filter((member) => member.serviceIds.includes(step.serviceId))
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              disabled={isSubmitting}
              className="min-h-11 text-sm underline"
              onClick={() => setExtra((items) => items.filter((_, i) => i !== index))}
            >
              Remove treatment
            </button>
          </fieldset>
        ))}
        {extra.length < 4 && (
          <button
            type="button"
            disabled={isSubmitting || !serviceId}
            className="min-h-11 text-sm font-semibold text-brand"
            onClick={() => {
              if (staffId === 'any')
                setStaffId(staff.find((member) => member.serviceIds.includes(serviceId))?.id ?? '');
              setExtra((items) => [...items, { serviceId: '', staffId: '' }]);
            }}
          >
            Add consecutive treatment
          </button>
        )}
        {!!extra.length && (
          <p className="text-sm text-muted">
            Choose a professional for each treatment. Times below fit the entire visit, including
            cleanup. All treatments are saved together.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="clientId" className="text-[14px] font-semibold text-ink">
          Client
        </label>
        <select
          id="clientId"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] outline-none transition-colors hover:border-ink/20 focus:border-ink focus:ring-1 focus:ring-ink"
          required
          aria-invalid={!!validationErrors.clientId}
          aria-describedby={validationErrors.clientId ? errId('clientId') : undefined}
        >
          <option value="" disabled>
            Select a client...
          </option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName} ({c.phone})
            </option>
          ))}
        </select>
        {validationErrors.clientId && (
          <span id={errId('clientId')} className="text-xs text-red-600">
            {validationErrors.clientId.join(', ')}
          </span>
        )}
      </div>

      {clientId && (
        <label className="grid gap-1 text-sm font-semibold">
          Appointment for
          <select
            disabled={isSubmitting || holderError}
            value={holderId}
            onChange={(event) => setHolderId(event.target.value)}
            className="min-h-11 rounded-lg border border-line px-3"
          >
            <option value="">The contact themselves</option>
            {holders.map((holder) => (
              <option key={holder.id} value={holder.id}>
                {holder.name}
              </option>
            ))}
          </select>
          {holderError && (
            <span role="alert" className="text-red-700">
              Could not load appointment holders. Choose the customer again to retry.
            </span>
          )}
        </label>
      )}
      {!!extra.length && timeStr && (
        <ol className="space-y-2 rounded-lg bg-surface p-3 text-sm">
          {sequenceSlots
            .find((slot) => slot.startsAt === timeStr)
            ?.appointments.map((appointment, index) => (
              <li key={index}>
                {services.find((service) => service.id === appointment.serviceId)?.name} ·{' '}
                {staff.find((member) => member.id === appointment.staffId)?.name} ·{' '}
                {new Date(appointment.startsAt).toLocaleTimeString([], {
                  timeZone: timezone,
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </li>
            ))}
        </ol>
      )}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="date" className="text-[14px] font-semibold text-ink">
            Date
          </label>
          <input
            type="date"
            id="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] outline-none transition-colors hover:border-ink/20 focus:border-ink focus:ring-1 focus:ring-ink"
            required
            aria-invalid={!!validationErrors.startsAt}
            aria-describedby={validationErrors.startsAt ? errId('startsAt') : undefined}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="timeStr" className="text-[14px] font-semibold text-ink">
            Time {isLoadingSlots && <span className="text-xs text-neutral-400">(Loading...)</span>}
          </label>
          <select
            id="timeStr"
            value={timeStr}
            onChange={(e) => {
              requestId.current = null;
              setTimeStr(e.target.value);
            }}
            className="h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] outline-none transition-colors hover:border-ink/20 focus:border-ink focus:ring-1 focus:ring-ink"
            required
            disabled={!serviceId || isLoadingSlots || availableSlots.length === 0}
            aria-invalid={!!validationErrors.startsAt}
            aria-describedby={validationErrors.startsAt ? errId('startsAt') : undefined}
          >
            <option value="" disabled>
              {extra.length > 0 &&
              (!staffId || extra.some((step) => !step.serviceId || !step.staffId))
                ? 'Complete treatment choices first'
                : availableSlots.length === 0 && !isLoadingSlots && serviceId
                  ? 'No slots available'
                  : 'Select time...'}
            </option>
            {availableSlots.map((slot) => {
              const d = new Date(slot.startsAt);
              const timeFormatted = new Intl.DateTimeFormat('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                timeZone: timezone,
              }).format(d);

              return (
                <option key={d.toISOString()} value={d.toISOString()}>
                  {timeFormatted}
                </option>
              );
            })}
          </select>
          {validationErrors.startsAt && (
            <span id={errId('startsAt')} className="text-xs text-red-600">
              {validationErrors.startsAt.join(', ')}
            </span>
          )}
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="submit"
          disabled={isSubmitting || holderError || !timeStr || !clientId || !serviceId}
          className="inline-flex h-12 w-full sm:w-auto items-center justify-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white transition-colors hover:bg-black/80 disabled:opacity-60"
        >
          {isSubmitting ? 'Booking...' : 'Create Booking'}
        </button>
      </div>
    </form>
  );
}
