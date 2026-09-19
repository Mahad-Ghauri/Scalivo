'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { Service } from '@scalivo/shared';
import { createServiceAction, updateServiceAction } from '@/app/(dashboard)/dashboard/[businessId]/services/actions';

interface ServiceModalProps {
  businessId: string;
  existingService?: Service | null;
  onClose: () => void;
  onSuccess: () => void;
}

export function ServiceModal({ businessId, existingService, onClose, onSuccess }: ServiceModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const isEditing = !!existingService;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(existingService?.name ?? '');
  const [duration, setDuration] = useState(existingService?.durationMinutes?.toString() ?? '60');
  const [price, setPrice] = useState(
    existingService ? (existingService.priceMinor / 100).toString() : '1000'
  );
  
  const [depositRequired, setDepositRequired] = useState(existingService?.depositRequired ?? false);
  const [depositAmount, setDepositAmount] = useState(
    existingService?.depositAmountMinor ? (existingService.depositAmountMinor / 100).toString() : '500'
  );
  
  const [active, setActive] = useState(existingService?.active ?? true);

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const priceNum = parseInt(price, 10);
    const durationNum = parseInt(duration, 10);
    const depositNum = parseInt(depositAmount, 10);

    if (isNaN(priceNum) || priceNum < 0) {
      setError('Please enter a valid price.');
      setLoading(false);
      return;
    }
    
    if (isNaN(durationNum) || durationNum <= 0) {
      setError('Please enter a valid duration in minutes.');
      setLoading(false);
      return;
    }

    if (depositRequired && (isNaN(depositNum) || depositNum <= 0)) {
      setError('Please enter a valid deposit amount.');
      setLoading(false);
      return;
    }

    const payload = {
      name: name.trim(),
      durationMinutes: durationNum,
      priceMinor: priceNum * 100, // Convert to minor units (paisa)
      depositRequired,
      depositAmountMinor: depositRequired ? depositNum * 100 : null,
      active,
    };

    try {
      if (isEditing) {
        await updateServiceAction(businessId, existingService.id, payload);
      } else {
        await createServiceAction(businessId, payload);
      }
      onSuccess();
    } catch (err: any) {
      setError(err?.message || 'Failed to save service.');
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
        className="w-full max-w-lg bg-white rounded-2xl shadow-xl flex flex-col max-h-full overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h2 className="text-[24px] font-bold tracking-[-0.02em]">
            {isEditing ? 'Edit Service' : 'New Service'}
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

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-ink mb-1">Service Name</label>
              <input
                type="text"
                required
                className="w-full rounded-md border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                placeholder="e.g. Men's Haircut"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-ink mb-1">Duration (minutes)</label>
                <input
                  type="number"
                  min="5"
                  step="5"
                  required
                  className="w-full rounded-md border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink mb-1">Price (PKR)</label>
                <input
                  type="number"
                  min="0"
                  required
                  className="w-full rounded-md border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>

            <div className="pt-2 border-t border-line">
              <label className="flex items-center space-x-2 text-sm font-medium text-ink">
                <input
                  type="checkbox"
                  className="rounded text-brand focus:ring-brand"
                  checked={depositRequired}
                  onChange={(e) => setDepositRequired(e.target.checked)}
                  disabled={loading}
                />
                <span>Require Deposit</span>
              </label>
              
              {depositRequired && (
                <div className="mt-3">
                  <label className="block text-sm font-medium text-ink mb-1">Deposit Amount (PKR)</label>
                  <input
                    type="number"
                    min="1"
                    required={depositRequired}
                    className="w-full rounded-md border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    disabled={loading}
                  />
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-line">
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
                Inactive services won't appear on the menu, but existing bookings will be preserved.
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
                {loading ? 'Saving...' : 'Save Service'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
