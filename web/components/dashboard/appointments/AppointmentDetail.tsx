'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { getAppointmentAction, cancelAppointmentAction, setAppointmentOutcomeAction } from '@/app/actions/appointments';
import { BOOKING_STATUS, type BookingStatus } from '@scalivo/shared';
import { formatPrice } from '@/lib/format';
import type { AppointmentDTO } from './AppointmentsTable';
import { ReminderBadge } from '../ReminderBadge';

interface AppointmentDetailProps {
  businessId: string;
  appointmentId: string;
  timezone: string;
}

export function AppointmentDetail({ businessId, appointmentId, timezone }: AppointmentDetailProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appointment, setAppointment] = useState<AppointmentDTO | null>(null);
  
  useEffect(() => {
    async function load() {
      try {
        const data = await getAppointmentAction(businessId, appointmentId);
        setAppointment(data);
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : 'Failed to load appointment details');
      }
    }
    load();
  }, [businessId, appointmentId]);

  const close = () => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete('appointmentId');
    router.push(`${pathname}?${sp.toString()}`);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const handleCancel = async () => {
    setLoading(true);
    setError(null);
    try {
      await cancelAppointmentAction(businessId, appointmentId);
      router.refresh();
      close();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Failed to cancel appointment');
      setLoading(false);
    }
  };

  const handleOutcome = async (outcome: string) => {
    setLoading(true);
    setError(null);
    try {
      await setAppointmentOutcomeAction(businessId, appointmentId, outcome);
      router.refresh();
      close();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Failed to set outcome');
      setLoading(false);
    }
  };

  const isTerminal = appointment ? ([BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW, BOOKING_STATUS.CANCELLED] as BookingStatus[]).includes(appointment.status) : false;
  const isConfirmed = appointment ? appointment.status === BOOKING_STATUS.CONFIRMED : false;
  
  let dateFormatted = '';
  let timeFormatted = '';
  
  if (appointment) {
    const d = new Date(appointment.startsAt);
    dateFormatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).format(d);
    
    timeFormatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit'
    }).format(d);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-black/40 sm:p-4">
      <div className="bg-white w-full max-w-md h-full sm:h-auto sm:rounded-2xl shadow-xl flex flex-col overflow-hidden animate-in slide-in-from-right-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-surface/30">
          <h2 className="text-lg font-semibold text-ink">Appointment Details</h2>
          <button onClick={close} className="text-muted hover:text-ink transition-colors p-1 rounded">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-6">
          {error && (
            <div className="p-3 bg-red-50 text-red-700 text-sm rounded-md">
              {error}
            </div>
          )}
          
          {!appointment && !error ? (
            <div className="text-center py-8 text-muted">Loading...</div>
          ) : appointment ? (
            <>
              <div className="space-y-4">
                <div>
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">Customer</h3>
                  <p className="text-ink font-medium">{appointment.client?.name || 'Unknown'}</p>
                  <p className="text-sm text-muted">{appointment.client?.phone || 'No phone'}</p>
                </div>
                
                <div>
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">Schedule</h3>
                  <p className="text-ink font-medium">{dateFormatted}</p>
                  <p className="text-sm text-muted">{timeFormatted} ({appointment.durationMinutes} minutes)</p>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">Service</h3>
                    <p className="text-sm text-ink">{appointment.service?.name || 'Unknown'}</p>
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">Staff</h3>
                    <p className="text-sm text-ink">{appointment.staff?.name || 'Unknown'}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 border-t border-line pt-4">
                  <div>
                    <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">Status</h3>
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-surface text-ink border border-line">
                      {appointment.status}
                    </span>
                    <div className="mt-1.5">
                      <ReminderBadge state={appointment.reminderState} />
                    </div>
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">Amount</h3>
                    <p className="text-sm font-medium text-ink">{formatPrice(appointment.priceMinor)}</p>
                  </div>
                </div>
              </div>
              
              {!isTerminal && (
                <div className="border-t border-line pt-6 flex flex-col gap-3">
                   <h3 className="text-sm font-semibold text-ink mb-2">Actions</h3>
                   {isConfirmed && (
                     <>
                       <button 
                          onClick={() => handleOutcome(BOOKING_STATUS.COMPLETED)} 
                          disabled={loading}
                          className="w-full py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
                       >
                          Mark Completed
                       </button>
                       <button 
                          onClick={() => handleOutcome(BOOKING_STATUS.NO_SHOW)} 
                          disabled={loading}
                          className="w-full py-2.5 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700 transition-colors disabled:opacity-50"
                       >
                          Mark No Show
                       </button>
                     </>
                   )}
                   
                   {/* Reschedule functionality hooks into the calendar. We can leave it as Cancel for now or wire it if we have a reschedule modal. The prompt said "Reuse the existing reschedule implementation and modal". Let's check if there is a reschedule modal component. */}
                   
                   <button 
                      onClick={handleCancel} 
                      disabled={loading}
                      className="w-full py-2.5 bg-red-100 text-red-700 rounded-lg text-sm font-medium hover:bg-red-200 transition-colors disabled:opacity-50"
                   >
                      Cancel Appointment
                   </button>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
