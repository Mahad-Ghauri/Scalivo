'use client';

import React, { useEffect, useRef } from 'react';
import { BookingForm } from './BookingForm';
import type { Service, Staff, Client } from '@scalivo/shared';

interface NewBookingModalProps {
  businessId: string;
  timezone: string;
  services: Service[];
  staff: Staff[];
  clients: Client[];
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function NewBookingModal({
  businessId,
  timezone,
  services,
  staff,
  clients,
  onClose,
  triggerRef,
}: NewBookingModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Trap focus & restore focus on close
  useEffect(() => {
    const focusableElements = modalRef.current?.querySelectorAll(
      'a[href], button, textarea, input[type="text"], input[type="radio"], input[type="checkbox"], select, [tabindex]:not([tabindex="-1"])',
    );
    const firstElement = focusableElements?.[0] as HTMLElement | undefined;
    const lastElement = focusableElements?.[focusableElements.length - 1] as
      HTMLElement | undefined;

    if (firstElement) {
      firstElement.focus();
    }

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            lastElement?.focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === lastElement) {
            firstElement?.focus();
            e.preventDefault();
          }
        }
      }
    };

    document.addEventListener('keydown', handleTabKey);

    // Prevent background scroll
    document.body.style.overflow = 'hidden';

    const currentTrigger = triggerRef?.current;

    return () => {
      document.removeEventListener('keydown', handleTabKey);
      document.body.style.overflow = '';
      if (currentTrigger) {
        currentTrigger.focus();
      }
    };
  }, [triggerRef]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        ref={modalRef}
        className="w-full max-w-md bg-white rounded-2xl shadow-xl flex flex-col max-h-full overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h2 id="modal-title" className="text-[24px] font-bold tracking-[-0.02em]">
            New Booking
          </h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink p-1 transition-colors"
            aria-label="Close modal"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
          <BookingForm
            businessId={businessId}
            timezone={timezone}
            services={services}
            staff={staff}
            clients={clients}
            onSuccess={onClose}
          />
        </div>
      </div>
    </div>
  );
}
