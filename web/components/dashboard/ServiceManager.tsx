'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Service } from '@scalivo/shared';
import { formatPrice, formatDuration } from '@/lib/format';
import { ServiceModal } from './ServiceModal';

interface ServiceManagerProps {
  businessId: string;
  services: Service[];
}

export function ServiceManager({ businessId, services }: ServiceManagerProps) {
  const router = useRouter();
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedService, setSelectedService] = useState<Service | null>(null);

  function openCreateModal() {
    setSelectedService(null);
    setIsModalOpen(true);
  }

  function openEditModal(service: Service) {
    setSelectedService(service);
    setIsModalOpen(true);
  }

  function handleSuccess() {
    setIsModalOpen(false);
    // Refresh the server component to pull the latest data
    router.refresh();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display font-semibold text-ink capitalize">Services</h1>
          <p className="mt-1 text-sm text-muted">Manage your services, pricing, and duration.</p>
        </div>
        <button
          onClick={openCreateModal}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90 transition-colors"
        >
          Add Service
        </button>
      </div>

      {services.length === 0 ? (
        <div className="rounded-lg border border-line bg-white p-12 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface">
            <svg className="h-6 w-6 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-medium text-ink">No services yet</h2>
          <p className="mt-2 text-sm text-muted">
            Create your first service to start accepting bookings.
          </p>
          <button
            onClick={openCreateModal}
            className="mt-6 rounded-md border border-line bg-white px-4 py-2 text-sm font-medium text-ink hover:bg-surface transition-colors"
          >
            Add Service
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-white overflow-hidden shadow-sm">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-surface">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider">
                  Service
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider">
                  Duration
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider">
                  Price
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider">
                  Deposit
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider">
                  Status
                </th>
                <th scope="col" className="relative px-6 py-3">
                  <span className="sr-only">Edit</span>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-line">
              {services.map((service) => (
                <tr key={service.id} className="hover:bg-surface/50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-ink">{service.name}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-ink">{formatDuration(service.durationMinutes)}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-ink">{formatPrice(service.priceMinor)}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-ink">
                      {service.depositRequired && service.depositAmountMinor
                        ? formatPrice(service.depositAmountMinor)
                        : '-'}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {service.active ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-brand/10 text-brand">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-surface text-muted">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => openEditModal(service)}
                      className="text-brand hover:text-brand-dark transition-colors"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isModalOpen && (
        <ServiceModal
          businessId={businessId}
          existingService={selectedService}
          onClose={() => setIsModalOpen(false)}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
