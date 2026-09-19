'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Staff, Service } from '@scalivo/shared';
import { StaffModal } from './StaffModal';

interface StaffManagerProps {
  businessId: string;
  staff: Staff[];
  services: Service[];
}

export function StaffManager({ businessId, staff, services }: StaffManagerProps) {
  const router = useRouter();
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState<Staff | null>(null);

  function openCreateModal() {
    setSelectedStaff(null);
    setIsModalOpen(true);
  }

  function openEditModal(member: Staff) {
    setSelectedStaff(member);
    setIsModalOpen(true);
  }

  function handleSuccess() {
    setIsModalOpen(false);
    router.refresh();
  }
  
  // Resolve service names for display
  const serviceNameMap = new Map(services.map(s => [s.id, s.name]));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display font-semibold text-ink capitalize">Staff</h1>
          <p className="mt-1 text-sm text-muted">Manage your team members and their schedules.</p>
        </div>
        <button
          onClick={openCreateModal}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90 transition-colors"
        >
          Add Staff Member
        </button>
      </div>

      {staff.length === 0 ? (
        <div className="rounded-lg border border-line bg-white p-12 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface">
            <svg className="h-6 w-6 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-medium text-ink">No staff yet</h2>
          <p className="mt-2 text-sm text-muted">
            Add team members to enable calendar bookings.
          </p>
          <button
            onClick={openCreateModal}
            className="mt-6 rounded-md border border-line bg-white px-4 py-2 text-sm font-medium text-ink hover:bg-surface transition-colors"
          >
            Add Staff Member
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-white overflow-hidden shadow-sm">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-surface">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider">
                  Name
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider">
                  Role
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider">
                  Assigned Services
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
              {staff.map((member) => (
                <tr key={member.id} className="hover:bg-surface/50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-ink">{member.name}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-ink">{member.role || '-'}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-ink flex flex-wrap gap-1 max-w-sm">
                      {member.serviceIds && member.serviceIds.length > 0 ? (
                        member.serviceIds.map(id => (
                          <span key={id} className="inline-flex bg-surface px-2 py-0.5 rounded text-xs text-muted border border-line">
                            {serviceNameMap.get(id) || 'Unknown'}
                          </span>
                        ))
                      ) : (
                        <span className="text-muted text-xs">No services</span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {member.active ? (
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
                      onClick={() => openEditModal(member)}
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
        <StaffModal
          businessId={businessId}
          existingStaff={selectedStaff}
          services={services}
          onClose={() => setIsModalOpen(false)}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
