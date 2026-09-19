'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { Staff, Service } from '@scalivo/shared';
import { BOOKING_STATUS } from '@scalivo/shared';

export function AppointmentsFilters({ staff, services }: { staff: Staff[], services: Service[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [status, setStatus] = useState(searchParams.get('status') || '');
  const [staffId, setStaffId] = useState(searchParams.get('staffId') || '');
  const [serviceId, setServiceId] = useState(searchParams.get('serviceId') || '');
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [from, setFrom] = useState(searchParams.get('from') || '');
  const [to, setTo] = useState(searchParams.get('to') || '');
  
  useEffect(() => {
    // Sync state if URL changes from outside (e.g. back button)
    setStatus(searchParams.get('status') || '');
    setStaffId(searchParams.get('staffId') || '');
    setServiceId(searchParams.get('serviceId') || '');
    setQ(searchParams.get('q') || '');
    setFrom(searchParams.get('from') || '');
    setTo(searchParams.get('to') || '');
  }, [searchParams]);

  const updateFilters = (updates: Record<string, string>) => {
    const sp = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) {
        sp.set(key, value);
      } else {
        sp.delete(key);
      }
    }
    // Reset to page 1 on filter change
    sp.delete('page');
    router.push(`${pathname}?${sp.toString()}`);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    updateFilters({ q, from, to });
  };

  return (
    <div className="bg-white p-4 rounded-xl border border-line flex flex-col gap-4 shadow-sm">
      <div className="flex flex-col md:flex-row gap-4 items-center">
        <form onSubmit={handleSearch} className="flex-1 w-full relative">
          <input 
            type="text" 
            placeholder="Search customer name or phone..." 
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-line rounded-lg text-sm outline-none focus:border-ink transition-colors"
          />
          <div className="absolute left-3 top-2.5 text-muted">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          </div>
        </form>

        <select 
          value={status} 
          onChange={(e) => updateFilters({ status: e.target.value })}
          className="w-full md:w-auto px-3 py-2 border border-line rounded-lg text-sm bg-white outline-none focus:border-ink"
        >
          <option value="">All Statuses</option>
          {Object.values(BOOKING_STATUS).map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select 
          value={serviceId} 
          onChange={(e) => updateFilters({ serviceId: e.target.value })}
          className="w-full md:w-auto px-3 py-2 border border-line rounded-lg text-sm bg-white outline-none focus:border-ink"
        >
          <option value="">All Services</option>
          {services.map(s => (
            <option key={s.id} value={s.id}>{s.name} {!s.active && '(Inactive)'}</option>
          ))}
        </select>

        <select 
          value={staffId} 
          onChange={(e) => updateFilters({ staffId: e.target.value })}
          className="w-full md:w-auto px-3 py-2 border border-line rounded-lg text-sm bg-white outline-none focus:border-ink"
        >
          <option value="">All Staff</option>
          {staff.map(s => (
            <option key={s.id} value={s.id}>{s.name} {!s.active && '(Inactive)'}</option>
          ))}
        </select>
      </div>
      
      <form onSubmit={handleSearch} className="flex flex-col md:flex-row gap-4 items-center">
        <div className="flex items-center gap-2 w-full md:w-auto">
          <label className="text-xs font-semibold text-muted uppercase">From</label>
          <input 
            type="date"
            value={from || ''}
            onChange={(e) => setFrom(e.target.value)}
            className="flex-1 md:w-auto px-3 py-1.5 border border-line rounded-lg text-sm outline-none focus:border-ink"
          />
        </div>
        <div className="flex items-center gap-2 w-full md:w-auto">
          <label className="text-xs font-semibold text-muted uppercase">To</label>
          <input 
            type="date"
            value={to || ''}
            onChange={(e) => setTo(e.target.value)}
            className="flex-1 md:w-auto px-3 py-1.5 border border-line rounded-lg text-sm outline-none focus:border-ink"
          />
        </div>
        <button type="submit" className="w-full md:w-auto px-4 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-ink text-sm font-medium rounded-lg transition-colors border border-line">
          Apply Dates
        </button>
        {(from || to) && (
          <button type="button" onClick={() => updateFilters({ from: '', to: '' })} className="text-sm text-brand hover:underline">
            Clear Dates
          </button>
        )}
      </form>
    </div>
  );
}
