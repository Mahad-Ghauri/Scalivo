'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { revokeCustomerLinkAction, saveAppointmentHolderAction } from '@/lib/actions/booking';

export function CustomerBookingTools({
  businessId,
  clientId,
  holders,
}: {
  businessId: string;
  clientId: string;
  holders: { id: string; name: string; active: boolean }[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await saveAppointmentHolderAction(businessId, clientId, editing, { name: name.trim() });
      setName('');
      setEditing(null);
      setNotice('Appointment holder saved.');
      router.refresh();
    } catch {
      setError('Could not save this person. Enter a name and try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-2xl border border-line bg-white p-6">
      <h2 className="text-lg font-semibold">Appointment holders & private link</h2>
      <p className="text-sm text-muted">
        The contact receives messages. Family members have their own appointment availability.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      )}
      <ul className="divide-y divide-line">
        {holders.map((holder) => (
          <li key={holder.id} className="flex items-center justify-between gap-4 py-2">
            <span>{holder.name}</span>
            <div className="flex gap-3">
              <button
                type="button"
                disabled={busy}
                className="min-h-11 underline"
                onClick={() => {
                  setEditing(holder.id);
                  setName(holder.name);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                disabled={busy}
                className="min-h-11 underline"
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Remove ${holder.name}? Upcoming appointments must be moved or cancelled first.`,
                    )
                  )
                    return;
                  setBusy(true);
                  setError('');
                  setNotice('');
                  try {
                    await saveAppointmentHolderAction(businessId, clientId, holder.id, {
                      name: holder.name,
                      active: false,
                    });
                    setNotice('Person removed. Appointment history is kept.');
                    router.refresh();
                  } catch {
                    setError(
                      'Could not remove this person. Resolve their upcoming appointments first.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form onSubmit={save} className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          {editing ? 'Edit name' : 'Add a person'}
          <input
            required
            maxLength={80}
            disabled={busy}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-h-11 rounded-lg border border-line px-3"
          />
        </label>
        <button
          disabled={busy || !name.trim() || (!editing && holders.length >= 20)}
          className="min-h-11 rounded-lg bg-brand px-4 text-white"
        >
          {busy ? 'Saving…' : 'Save person'}
        </button>
        {editing && (
          <button
            type="button"
            disabled={busy}
            className="min-h-11 underline"
            onClick={() => {
              setEditing(null);
              setName('');
            }}
          >
            Cancel edit
          </button>
        )}
      </form>
      <button
        type="button"
        disabled={busy}
        className="min-h-11 rounded-lg border border-line px-4 text-sm font-semibold"
        onClick={async () => {
          if (
            !window.confirm(
              'Revoke this customer’s private link? Their previous link and installed shortcut will stop working. A new link will be included in their next confirmation.',
            )
          )
            return;
          setBusy(true);
          setError('');
          setNotice('');
          try {
            await revokeCustomerLinkAction(businessId, clientId);
            setNotice('Previous private link revoked.');
          } catch {
            setError('Could not revoke the link. Try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        Revoke private link
      </button>
    </section>
  );
}
