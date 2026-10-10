'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BOOKING_STATUS, type CalendarEntry, type Service, type Staff } from '@scalivo/shared';
import {
  approveBookingAction,
  correctBookingOutcomeAction,
  cancelBookingAction,
  setBookingOutcomeAction,
} from '@/lib/actions/booking';
import { RescheduleModal } from './RescheduleModal';

interface CalendarDetailActionsProps {
  businessId: string;
  timezone: string;
  entry: CalendarEntry;
  services: Service[];
  staff: Staff[];
}

export function CalendarDetailActions({
  businessId,
  timezone,
  entry,
  services,
  staff,
}: CalendarDetailActionsProps) {
  const router = useRouter();
  const [isProcessing, setIsProcessing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showReschedule, setShowReschedule] = useState(false);

  const [now, setNow] = useState(Date.now());
  const [correction, setCorrection] = useState<'completed' | 'no_show' | 'cancelled'>('cancelled');
  const [reason, setReason] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const isTerminal = (
    [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW, BOOKING_STATUS.CANCELLED] as string[]
  ).includes(entry.status);
  const isConfirmed = entry.status === BOOKING_STATUS.CONFIRMED;
  const canComplete = isConfirmed && new Date(entry.endsAt).getTime() <= now;
  const canNoShow = isConfirmed && new Date(entry.startsAt).getTime() + 10 * 60000 <= now;

  if (isTerminal)
    return (
      <form
        className="mt-4 space-y-3 border-t border-line pt-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            !window.confirm(
              'Correct this recorded outcome? The change and reason will be saved in the audit history.',
            )
          )
            return;
          setIsProcessing(true);
          setActionError(null);
          const result = await correctBookingOutcomeAction(businessId, entry.id, {
            outcome: correction,
            revision: entry.revision ?? 0,
            reason: reason.trim(),
          });
          if (result.success) router.refresh();
          else
            setActionError(
              'Could not correct this outcome. It may have changed or the replacement outcome is not yet eligible. Refresh and try again.',
            );
          setIsProcessing(false);
        }}
      >
        <p className="text-sm text-muted">
          Correct a recorded outcome with a reason. Messages and review requests are not sent again.
        </p>
        {actionError && (
          <p role="alert" className="text-sm text-red-600">
            {actionError}
          </p>
        )}
        <label className="block text-sm">
          Correct outcome
          <select
            disabled={isProcessing}
            value={correction}
            onChange={(event) => setCorrection(event.target.value as typeof correction)}
            className="mt-1 w-full rounded border border-line p-2"
          >
            <option value="completed">Completed</option>
            <option value="no_show">No-show</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label className="block text-sm">
          Reason
          <textarea
            minLength={5}
            maxLength={200}
            required
            disabled={isProcessing}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="mt-1 w-full rounded border border-line p-2"
          />
        </label>
        <button
          disabled={isProcessing || correction === entry.status || reason.trim().length < 5}
          className="h-12 w-full rounded-full border border-line disabled:opacity-50"
        >
          Save correction
        </button>
      </form>
    );

  const handleCancel = async () => {
    if (
      !window.confirm(
        'Are you sure you want to cancel this booking? This will free the slot immediately.',
      )
    ) {
      return;
    }

    setIsProcessing(true);
    setActionError(null);

    const res = await cancelBookingAction(businessId, entry.id);
    if (res.success) {
      router.refresh(); // Refresh calendar grid
    } else {
      setActionError(
        res.error === 'already_terminal'
          ? 'Already cancelled or completed.'
          : 'Could not cancel booking.',
      );
      setIsProcessing(false);
    }
  };

  const handleOutcome = async (
    outcome: 'completed' | 'no_show',
    earlyCompletionReason?: string,
  ) => {
    const actionName = outcome === 'completed' ? 'complete' : 'no-show';
    if (!window.confirm(`Are you sure you want to mark this booking as ${actionName}?`)) {
      return;
    }

    setIsProcessing(true);
    setActionError(null);

    const res = await setBookingOutcomeAction(businessId, entry.id, outcome, earlyCompletionReason);
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
      {actionError && <p className="text-sm text-red-600 mb-2">{actionError}</p>}

      {entry.status === BOOKING_STATUS.AWAITING_APPROVAL && (
        <>
          <p className="text-sm text-muted">
            This request is holding capacity while awaiting your approval.
          </p>
          <button
            disabled={isProcessing}
            className="h-12 rounded-full bg-open text-white disabled:opacity-50"
            onClick={async () => {
              if (!window.confirm('Accept this appointment request?')) return;
              setIsProcessing(true);
              setActionError(null);
              const result = await approveBookingAction(businessId, entry.id);
              if (result.success) router.refresh();
              else setActionError('Could not accept. The request may have expired or changed.');
              setIsProcessing(false);
            }}
          >
            Accept request
          </button>
        </>
      )}
      {isConfirmed && !canComplete && new Date(entry.startsAt).getTime() <= now && (
        <button
          disabled={isProcessing}
          className="min-h-11 text-sm underline"
          onClick={() => {
            const reason = window
              .prompt(
                'Why are you recording completion before the scheduled end? A reason of 5–200 characters is required.',
              )
              ?.trim();
            if (reason && reason.length >= 5 && reason.length <= 200)
              void handleOutcome('completed', reason);
          }}
        >
          Treatment finished early? Record completion with a reason
        </button>
      )}
      {isConfirmed && (
        <div className="flex flex-col gap-3 pb-3 border-b border-line border-dashed">
          <button
            type="button"
            onClick={() => handleOutcome('completed')}
            disabled={isProcessing || !canComplete}
            title={canComplete ? undefined : 'Available after the appointment ends'}
            className="inline-flex h-12 w-full items-center justify-center rounded-full bg-open px-6 text-[16px] font-semibold text-white transition-colors hover:bg-open/80 disabled:opacity-60"
          >
            Mark Completed
          </button>
          <button
            type="button"
            onClick={() => handleOutcome('no_show')}
            disabled={isProcessing || !canNoShow}
            title={canNoShow ? undefined : 'Available ten minutes after appointment start'}
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
          {isProcessing
            ? 'Processing...'
            : entry.status === BOOKING_STATUS.AWAITING_APPROVAL
              ? 'Decline request'
              : 'Cancel Booking'}
        </button>
      </div>

      {showReschedule && (
        <RescheduleModal
          businessId={businessId}
          timezone={timezone}
          entry={entry}
          services={services}
          staff={staff}
          onClose={() => setShowReschedule(false)}
        />
      )}
    </div>
  );
}
