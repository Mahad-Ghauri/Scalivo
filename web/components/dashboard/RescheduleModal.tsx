'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { CalendarEntry, Service, Staff, AvailableSlot } from '@scalivo/shared';
import { getAvailabilityAction, rescheduleBookingAction } from '@/lib/actions/booking';

interface RescheduleModalProps {
  businessId: string;
  entry: CalendarEntry;
  services: Service[];
  staff: Staff[];
  onClose: () => void;
}

export function RescheduleModal({
  businessId,
  entry,
  services,
  staff,
  onClose,
}: RescheduleModalProps) {
  const router = useRouter();
  const modalRef = useRef<HTMLDivElement>(null);

  const [staffId, setStaffId] = useState(entry.staffId);
  const [date, setDate] = useState(() => {
    // Current date in local format string YYYY-MM-DD
    const d = new Date(entry.startsAt);
    return d.toISOString().split('T')[0]!;
  });
  const [timeStr, setTimeStr] = useState('');

  const [availableSlots, setAvailableSlots] = useState<AvailableSlot[]>([]);
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const service = services.find(s => s.id === entry.serviceId) || { name: entry.serviceName, id: entry.serviceId };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    async function loadSlots() {
      if (!date) {
        setAvailableSlots([]);
        setTimeStr('');
        return;
      }
      setIsLoadingSlots(true);
      setAvailableSlots([]);
      setTimeStr('');
      try {
        const slots = await getAvailabilityAction(businessId, service.id, date, staffId);
        if (active) {
          setAvailableSlots(slots);
        }
      } catch {
        // failed
      } finally {
        if (active) setIsLoadingSlots(false);
      }
    }
    loadSlots();
    return () => { active = false; };
  }, [businessId, service.id, staffId, date]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    const res = await rescheduleBookingAction(businessId, entry.id, {
      serviceId: service.id,
      staffId,
      startsAt: timeStr,
    });

    setIsSubmitting(false);
    if (res.success) {
      router.refresh();
      onClose();
    } else {
      if (res.error === 'slot_taken') setErrorMessage('That time was just taken, please pick another.');
      else if (res.error === 'already_terminal') setErrorMessage('Booking is already cancelled or completed.');
      else setErrorMessage('Could not reschedule. Please try again.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={modalRef}
        className="w-full max-w-md bg-white rounded-2xl shadow-xl flex flex-col max-h-full overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h2 className="text-[24px] font-bold tracking-[-0.02em]">
            Reschedule Booking
          </h2>
          <button onClick={onClose} className="text-muted hover:text-ink p-1 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {errorMessage && (
              <div className="p-3 bg-red-50 text-red-700 text-sm rounded-md mb-2">
                {errorMessage}
              </div>
            )}
            
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">Customer & Service</p>
              <p className="text-sm font-medium text-ink">{entry.clientName || 'Walk-in'}</p>
              <p className="text-sm text-muted">{service.name}</p>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="resched-staffId" className="text-[14px] font-semibold text-ink">Staff</label>
              <select
                id="resched-staffId"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                className="h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] outline-none transition-colors hover:border-ink/20 focus:border-ink focus:ring-1 focus:ring-ink"
              >
                <option value="any">Any Available Staff</option>
                {staff.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label htmlFor="resched-date" className="text-[14px] font-semibold text-ink">Date</label>
                <input
                  type="date"
                  id="resched-date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] outline-none transition-colors hover:border-ink/20 focus:border-ink focus:ring-1 focus:ring-ink"
                  required
                />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="resched-timeStr" className="text-[14px] font-semibold text-ink">
                  Time {isLoadingSlots && <span className="text-xs text-neutral-400">(Loading...)</span>}
                </label>
                <select
                  id="resched-timeStr"
                  value={timeStr}
                  onChange={(e) => setTimeStr(e.target.value)}
                  className="h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] outline-none transition-colors hover:border-ink/20 focus:border-ink focus:ring-1 focus:ring-ink"
                  required
                  disabled={isLoadingSlots || availableSlots.length === 0}
                >
                  <option value="" disabled>
                    {availableSlots.length === 0 && !isLoadingSlots ? 'No slots' : 'Select time...'}
                  </option>
                  {availableSlots.map((slot) => {
                    const d = new Date(slot.startsAt);
                    const timeFormatted = new Intl.DateTimeFormat('en-US', {
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(d);
                    
                    return (
                      <option key={d.toISOString()} value={d.toISOString()}>
                        {timeFormatted}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-12 w-full sm:w-auto items-center justify-center rounded-full bg-surface px-6 text-[16px] font-semibold text-ink transition-colors hover:bg-surface/80 border border-line disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !timeStr}
                className="inline-flex h-12 w-full sm:w-auto items-center justify-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white transition-colors hover:bg-black/80 disabled:opacity-60"
              >
                {isSubmitting ? 'Saving...' : 'Confirm Reschedule'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
