'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BOOKING_STATUS, type CalendarEntry, type Service, type Staff } from '@scalivo/shared';
import { cancelBookingAction, setBookingOutcomeAction } from '@/lib/actions/booking';
import { RescheduleModal } from './RescheduleModal';

interface CalendarDetailActionsProps {
  businessId: string;
  entry: CalendarEntry;
  services: Service[];
  staff: Staff[];
}

export function CalendarDetailActions({ businessId, entry, services, staff }: CalendarDetailActionsProps) {
  const router = useRouter();
  const [isProcessing, setIsProcessing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showReschedule, setShowReschedule] = useState(false);

  const isTerminal = ([BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW, BOOKING_STATUS.CANCELLED] as string[]).includes(entry.status);
  const isConfirmed = entry.status === BOOKING_STATUS.CONFIRMED;
  const hasStarted = new Date(entry.startsAt).getTime() <= Date.now();
  const canMarkOutcome = isConfirmed && hasStarted;

  if (isTerminal) {
    return (
      <div className="mt-4 pt-4 border-t border-line text-sm text-muted italic">
        No actions available for this status.
      </div>
    );
  }

  const handleCancel = async () => {
    if (!window.confirm('Are you sure you want to cancel this booking? This will free the slot immediately.')) {
      return;
    }
    
    setIsProcessing(true);
    setActionError(null);
    
    const res = await cancelBookingAction(businessId, entry.id);
    if (res.success) {
      router.refresh(); // Refresh calendar grid
    } else {
      setActionError(res.error === 'already_terminal' ? 'Already cancelled or completed.' : 'Could not cancel booking.');
      setIsProcessing(false);
    }
  };

  const handleOutcome = async (outcome: 'completed' | 'no_show') => {
    const actionName = outcome === 'completed' ? 'complete' : 'no-show';
    if (!window.confirm(`Are you sure you want to mark this booking as ${actionName}?`)) {
      return;
    }
    
    setIsProcessing(true);
    setActionError(null);
    
    const res = await setBookingOutcomeAction(businessId, entry.id, outcome);
    if (res.success) {
      router.refresh();
    } else {
      let msg = 'Could not update booking.';
      if (res.error === 'already_terminal') msg = 'Booking is already completed or cancelled.';
      if (res.error === 'invalid_status') msg = 'Only confirmed bookings can be marked complete.';
      if (res.error === 'not_yet_occurred') msg = 'Cannot mark a booking that has not started yet.';
      setActionError(msg);
      setIsProcessing(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-line flex flex-col gap-3">
      {actionError && (
        <p className="text-sm text-red-600 mb-2">{actionError}</p>
      )}

      {canMarkOutcome && (
        <div className="flex flex-col gap-3 pb-3 border-b border-line border-dashed">
          <button
            type="button"
            onClick={() => handleOutcome('completed')}
            disabled={isProcessing}
            className="inline-flex h-12 w-full items-center justify-center rounded-full bg-open px-6 text-[16px] font-semibold text-white transition-colors hover:bg-open/80 disabled:opacity-60"
          >
            Mark Completed
          </button>
          <button
            type="button"
            onClick={() => handleOutcome('no_show')}
            disabled={isProcessing}
            className="inline-flex h-12 w-full items-center justify-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white transition-colors hover:bg-black/80 disabled:opacity-60"
          >
            Mark No-Show
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setShowReschedule(true)}
          disabled={isProcessing}
          className="inline-flex h-12 w-full items-center justify-center rounded-full bg-surface px-6 text-[16px] font-semibold text-ink transition-colors hover:bg-surface/80 border border-line disabled:opacity-60"
        >
          Reschedule
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={isProcessing}
          className="inline-flex h-12 w-full items-center justify-center rounded-full px-6 text-[16px] font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-60"
        >
          {isProcessing ? 'Processing...' : 'Cancel Booking'}
        </button>
      </div>

      {showReschedule && (
        <RescheduleModal
          businessId={businessId}
          entry={entry}
          services={services}
          staff={staff}
          onClose={() => setShowReschedule(false)}
        />
      )}
    </div>
  );
}
