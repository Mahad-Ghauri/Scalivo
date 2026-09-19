'use client';

import React, { useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { NewBookingModal } from './NewBookingModal';
import type { Service, Staff, Client } from '@scalivo/shared';
// Let's use simple SVG icons if they don't exist, but ArrowEast is in the codebase.

interface CalendarControlsProps {
  businessId: string;
  view: 'day' | 'week';
  currentDate: string; // YYYY-MM-DD
  todayDate: string;
  prevDate: string;
  nextDate: string;
  title: string;
  services: Service[];
  staff: Staff[];
  clients: Client[];
  showCancelled: boolean;
}

export function CalendarControls({ businessId, view, todayDate, prevDate, nextDate, title, services, staff, clients, showCancelled }: CalendarControlsProps) {
  const basePath = `/dashboard/${businessId}/calendar`;
  const [isModalOpen, setIsModalOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleToggleCancelled = (e: React.ChangeEvent<HTMLInputElement>) => {
    const params = new URLSearchParams(searchParams.toString());
    if (e.target.checked) {
      params.set('showCancelled', 'true');
    } else {
      params.delete('showCancelled');
    }
    router.push(`${basePath}?${params.toString()}`);
  };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-display font-semibold text-ink min-w-[200px]">{title}</h1>
        
        <div className="flex items-center rounded-md border border-line bg-white shadow-sm">
          <Link
            href={`${basePath}?date=${prevDate}&view=${view}`}
            className="flex h-9 w-9 items-center justify-center border-r border-line text-ink hover:bg-surface"
            aria-label="Previous"
          >
            <span className="sr-only">Previous</span>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          
          <Link
            href={`${basePath}?date=${todayDate}&view=${view}`}
            className="flex h-9 items-center justify-center px-4 text-sm font-medium text-ink hover:bg-surface"
          >
            Today
          </Link>

          <Link
            href={`${basePath}?date=${nextDate}&view=${view}`}
            className="flex h-9 w-9 items-center justify-center border-l border-line text-ink hover:bg-surface"
            aria-label="Next"
          >
            <span className="sr-only">Next</span>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center rounded-md border border-line bg-white shadow-sm p-1">
          <Link
            href={`${basePath}?date=${todayDate}&view=day`}
            className={`px-3 py-1 text-sm rounded-sm font-medium ${
              view === 'day' ? 'bg-surface text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            Day
          </Link>
          <Link
            href={`${basePath}?date=${todayDate}&view=week`}
            className={`px-3 py-1 text-sm rounded-sm font-medium ${
              view === 'week' ? 'bg-surface text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            Week
          </Link>
        </div>
        
        <label className="flex items-center gap-2 text-sm font-medium text-ink cursor-pointer bg-white px-3 py-1.5 rounded-md border border-line shadow-sm">
          <input
            type="checkbox"
            className="rounded border-line text-ink focus:ring-ink"
            checked={showCancelled}
            onChange={handleToggleCancelled}
          />
          Show cancelled
        </label>
        
        <button
          ref={buttonRef}
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 rounded-md bg-ink text-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-neutral-800 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Booking
        </button>
      </div>

      {isModalOpen && (
        <NewBookingModal
          businessId={businessId}
          services={services}
          staff={staff}
          clients={clients}
          onClose={() => setIsModalOpen(false)}
          triggerRef={buttonRef}
        />
      )}
    </div>
  );
}
