'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { Staff, Service } from '@scalivo/shared';
import { createStaffAction, updateStaffAction } from '@/app/(dashboard)/dashboard/[businessId]/staff/actions';

interface WorkingHour {
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  breaks: { startsAt: string; endsAt: string }[];
}

interface StaffModalProps {
  businessId: string;
  existingStaff?: Staff | null;
  services: Service[];
  onClose: () => void;
  onSuccess: () => void;
}

const DAYS_OF_WEEK = [
  { id: 1, name: 'Monday' },
  { id: 2, name: 'Tuesday' },
  { id: 3, name: 'Wednesday' },
  { id: 4, name: 'Thursday' },
  { id: 5, name: 'Friday' },
  { id: 6, name: 'Saturday' },
  { id: 0, name: 'Sunday' },
];

export function StaffModal({ businessId, existingStaff, services, onClose, onSuccess }: StaffModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const isEditing = !!existingStaff;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(existingStaff?.name ?? '');
  const [role, setRole] = useState(existingStaff?.role ?? '');
  const [active, setActive] = useState(existingStaff?.active ?? true);
  
  // Set of selected service IDs
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(
    new Set(existingStaff?.serviceIds ?? [])
  );

  // Map of dayOfWeek -> working hours details
  const [workingHoursMap, setWorkingHoursMap] = useState<Record<number, { active: boolean; opensAt: string; closesAt: string }>>(() => {
    const initialMap: Record<number, { active: boolean; opensAt: string; closesAt: string }> = {};
    // Initialize all to false
    for (let i = 0; i < 7; i++) {
      initialMap[i] = { active: false, opensAt: '09:00', closesAt: '17:00' };
    }
    // Overlay existing schedule
    if (existingStaff?.workingHours) {
      existingStaff.workingHours.forEach((wh: WorkingHour) => {
        initialMap[wh.dayOfWeek] = { active: true, opensAt: wh.opensAt, closesAt: wh.closesAt };
      });
    }
    return initialMap;
  });

  // Focus trap and escape close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  function toggleService(serviceId: string) {
    const newSet = new Set(selectedServiceIds);
    if (newSet.has(serviceId)) {
      newSet.delete(serviceId);
    } else {
      newSet.add(serviceId);
    }
    setSelectedServiceIds(newSet);
  }

  function updateWorkingHour(day: number, field: 'active' | 'opensAt' | 'closesAt', value: any) {
    setWorkingHoursMap(prev => ({
      ...prev,
      [day]: {
        ...prev[day],
        [field]: value
      }
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Construct the workingHours array
    const workingHours: WorkingHour[] = [];
    for (let i = 0; i < 7; i++) {
      const wh = workingHoursMap[i];
      if (wh.active) {
        // Validation: opensAt must be strictly before closesAt
        const openTime = parseInt(wh.opensAt.replace(':', ''));
        const closeTime = parseInt(wh.closesAt.replace(':', ''));
        
        if (closeTime <= openTime) {
          setError(`Invalid hours on ${DAYS_OF_WEEK.find(d => d.id === i)?.name}: closing time must be after opening time.`);
          setLoading(false);
          return;
        }

        workingHours.push({
          dayOfWeek: i,
          opensAt: wh.opensAt,
          closesAt: wh.closesAt,
          breaks: []
        });
      }
    }

    const payload = {
      name: name.trim(),
      role: role.trim() || null,
      serviceIds: Array.from(selectedServiceIds),
      workingHours,
      active,
    };

    try {
      if (isEditing) {
        await updateStaffAction(businessId, existingStaff.id, payload);
      } else {
        await createStaffAction(businessId, payload);
      }
      onSuccess();
    } catch (err: any) {
      setError(err?.message || 'Failed to save staff member.');
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={modalRef}
        className="w-full max-w-2xl bg-white rounded-2xl shadow-xl flex flex-col max-h-[90vh] overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-line shrink-0">
          <h2 className="text-[24px] font-bold tracking-[-0.02em]">
            {isEditing ? 'Edit Staff Member' : 'New Staff Member'}
          </h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink p-1 transition-colors"
            aria-label="Close modal"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
          {error && (
            <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-ink mb-1">Name</label>
                <input
                  type="text"
                  required
                  className="w-full rounded-md border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="e.g. Sarah"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink mb-1">Role (Optional)</label>
                <input
                  type="text"
                  className="w-full rounded-md border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="e.g. Senior Stylist"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>

            <div className="pt-2 border-t border-line">
              <label className="block text-sm font-medium text-ink mb-3">Assigned Services</label>
              {services.length === 0 ? (
                <p className="text-sm text-muted">No active services found. Create some services first.</p>
              ) : (
                <div className="grid grid-cols-2 gap-3 max-h-48 overflow-y-auto p-1">
                  {services.map(service => (
                    <label key={service.id} className="flex items-center space-x-2 text-sm text-ink cursor-pointer">
                      <input
                        type="checkbox"
                        className="rounded text-brand focus:ring-brand"
                        checked={selectedServiceIds.has(service.id)}
                        onChange={() => toggleService(service.id)}
                        disabled={loading || !service.active}
                      />
                      <span className={service.active ? '' : 'text-muted line-through'}>
                        {service.name} {service.active ? '' : '(Inactive)'}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-line">
              <label className="block text-sm font-medium text-ink mb-3">Working Hours</label>
              <div className="space-y-3">
                {DAYS_OF_WEEK.map(day => {
                  const data = workingHoursMap[day.id];
                  return (
                    <div key={day.id} className="flex items-center space-x-4">
                      <label className="flex items-center space-x-2 text-sm font-medium w-32 cursor-pointer">
                        <input
                          type="checkbox"
                          className="rounded text-brand focus:ring-brand"
                          checked={data.active}
                          onChange={(e) => updateWorkingHour(day.id, 'active', e.target.checked)}
                          disabled={loading}
                        />
                        <span className={data.active ? 'text-ink' : 'text-muted'}>{day.name}</span>
                      </label>
                      
                      {data.active ? (
                        <div className="flex items-center space-x-2">
                          <input
                            type="time"
                            required={data.active}
                            className="rounded-md border border-line px-2 py-1 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                            value={data.opensAt}
                            onChange={(e) => updateWorkingHour(day.id, 'opensAt', e.target.value)}
                            disabled={loading}
                          />
                          <span className="text-muted text-sm">to</span>
                          <input
                            type="time"
                            required={data.active}
                            className="rounded-md border border-line px-2 py-1 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                            value={data.closesAt}
                            onChange={(e) => updateWorkingHour(day.id, 'closesAt', e.target.value)}
                            disabled={loading}
                          />
                        </div>
                      ) : (
                        <span className="text-sm text-muted">Off</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="pt-4 border-t border-line">
              <label className="flex items-center space-x-2 text-sm font-medium text-ink">
                <input
                  type="checkbox"
                  className="rounded text-brand focus:ring-brand"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  disabled={loading}
                />
                <span>Active (Available for booking)</span>
              </label>
              <p className="mt-1 text-xs text-muted ml-5">
                Inactive staff won't receive new bookings, but historical records are kept safe.
              </p>
            </div>

            <div className="mt-6 flex justify-end gap-3 pt-4 border-t border-line">
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="px-4 py-2 text-sm font-medium text-ink bg-surface rounded-md hover:bg-surface-hover transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !name.trim()}
                className="px-4 py-2 text-sm font-medium text-white bg-brand rounded-md hover:bg-brand/90 transition-colors disabled:opacity-50"
              >
                {loading ? 'Saving...' : 'Save Staff Member'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
