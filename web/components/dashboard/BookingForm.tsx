'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Service, Staff, Client, AvailableSlot } from '@scalivo/shared';
import { getAvailabilityAction, createBookingAction } from '@/lib/actions/booking';

interface BookingFormProps {
  businessId: string;
  services: Service[];
  staff: Staff[];
  clients: Client[];
  onSuccess: () => void;
}

export function BookingForm({ businessId, services, staff, clients, onSuccess }: BookingFormProps) {
  const router = useRouter();
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('any');
  const [clientId, setClientId] = useState('');
  
  // Date defaults to today in local time, though it requires proper parsing.
  // Using simple YYYY-MM-DD input.
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
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
      try {
        const slots = await getAvailabilityAction(businessId, serviceId, date, staffId);
        if (active) {
          setAvailableSlots(slots);
        }
      } catch {
        // generic fetch failure
      } finally {
        if (active) {
          setIsLoadingSlots(false);
        }
      }
    }

    loadSlots();
    return () => { active = false; };
  }, [businessId, serviceId, staffId, date]);

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
      startsAt: timeStr,
    });

    setIsSubmitting(false);

    if (res.success) {
      setSuccessMessage('Booking successfully created!');
      // Wait a moment for screen readers to announce, then close
      setTimeout(() => {
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
          <div className="p-3 bg-red-50 text-red-700 text-sm rounded-md mb-2">
            {genericError}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="serviceId" className="text-[14px] font-semibold text-ink">
          Service
        </label>
        <select
          id="serviceId"
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          className="h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] outline-none transition-colors hover:border-ink/20 focus:border-ink focus:ring-1 focus:ring-ink"
          required
          aria-invalid={!!validationErrors.serviceId}
          aria-describedby={validationErrors.serviceId ? errId('serviceId') : undefined}
        >
          <option value="" disabled>Select a service...</option>
          {services.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
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
          <option value="any">Any Available Staff</option>
          {staff
            .filter(s => !serviceId || s.serviceIds?.includes(serviceId))
            .map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
        </select>
        {validationErrors.staffId && (
          <span id={errId('staffId')} className="text-xs text-red-600">
            {validationErrors.staffId.join(', ')}
          </span>
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
          <option value="" disabled>Select a client...</option>
          {clients.map(c => (
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
            onChange={(e) => setTimeStr(e.target.value)}
            className="h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] outline-none transition-colors hover:border-ink/20 focus:border-ink focus:ring-1 focus:ring-ink"
            required
            disabled={!serviceId || isLoadingSlots || availableSlots.length === 0}
            aria-invalid={!!validationErrors.startsAt}
            aria-describedby={validationErrors.startsAt ? errId('startsAt') : undefined}
          >
            <option value="" disabled>
              {availableSlots.length === 0 && !isLoadingSlots && serviceId 
                ? 'No slots available' 
                : 'Select time...'}
            </option>
            {availableSlots.map((slot) => {
              const d = new Date(slot.startsAt);
              const timeFormatted = new Intl.DateTimeFormat('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                // Local timezone by default in browser
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
          disabled={isSubmitting || !timeStr || !clientId || !serviceId}
          className="inline-flex h-12 w-full sm:w-auto items-center justify-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white transition-colors hover:bg-black/80 disabled:opacity-60"
        >
          {isSubmitting ? 'Booking...' : 'Create Booking'}
        </button>
      </div>
    </form>
  );
}
