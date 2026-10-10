'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Resource } from '@scalivo/shared';
import { formatWhen } from '@/lib/format';
import {
  saveResourceAction,
  blockResourceAction,
  removeResourceBlockAction,
} from '@/app/(dashboard)/dashboard/[businessId]/services/actions';

export function ResourceManager({
  businessId,
  resources,
  blocks,
  timezone,
}: {
  businessId: string;
  resources: Resource[];
  blocks: {
    id: string;
    resourceId: string;
    startsAt: string;
    endsAt: string;
    reason: string | null;
  }[];
  timezone: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Resource | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Resource['kind']>('room');
  const [quantity, setQuantity] = useState('1');
  const [room, setRoom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [downtime, setDowntime] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  function edit(resource: Resource | null) {
    setEditing(resource);
    setName(resource?.name ?? '');
    setKind(resource?.kind ?? 'room');
    setQuantity(String(resource?.quantity ?? 1));
    setRoom(resource?.fixedRoomId ?? '');
    setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const units = Number(quantity);
    if (!Number.isInteger(units) || units < 1 || units > 20) {
      setError('Enter a whole quantity from 1 to 20');
      return;
    }
    if ((kind === 'bed' || kind === 'chair') && !room) {
      setError('Choose the room containing these beds or chairs');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await saveResourceAction(businessId, editing?.id ?? null, {
        name: name.trim(),
        kind,
        quantity: units,
        fixedRoomId: kind !== 'room' && room ? room : null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(undefined);
      router.refresh();
    } catch {
      setError(
        'Could not save. Check the name, quantity and room assignment. Each room containing stations must have quantity 1. Move or cancel affected appointments before moving resources or reducing occupied units.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function toggle(resource: Resource) {
    if (
      !window.confirm(
        `${resource.active ? 'Retire' : 'Restore'} ${resource.name}? Retirement is blocked while services or upcoming appointments depend on it.`,
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      const result = await saveResourceAction(businessId, resource.id, {
        active: !resource.active,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setError(
        'Could not change availability. Remove active service requirements and resolve upcoming appointments first.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-8 rounded-lg border border-line bg-white p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Rooms & equipment</h2>
        <button
          type="button"
          disabled={busy}
          className="min-h-11 rounded-md bg-brand px-4 py-2 text-white"
          onClick={() => edit(null)}
        >
          Add resource
        </button>
      </div>
      <p className="mt-2 text-sm text-muted">
        Add rooms, their beds/chairs, and equipment. Quantity counts interchangeable units. A
        bed/chair booking shares its room; a whole-room booking keeps all its stations private. Link
        the same inventory to every service that uses it.
      </p>
      {editing !== undefined && (
        <form onSubmit={save} className="mt-4 space-y-3 rounded-md border border-line p-4">
          <h3 className="font-medium">{editing ? 'Edit resource' : 'New resource'}</h3>
          <label className="block">
            Name
            <input
              required
              autoFocus
              maxLength={80}
              disabled={busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="ml-3 rounded-md border border-line p-2"
            />
          </label>
          <label className="block">
            Type
            <select
              disabled={busy}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as Resource['kind']);
                setRoom('');
              }}
              className="ml-3 rounded-md border border-line p-2"
            >
              <option value="room">Whole room</option>
              <option value="bed">Bed</option>
              <option value="chair">Chair</option>
              <option value="equipment">Equipment</option>
            </select>
          </label>
          <label className="block">
            Quantity{' '}
            <input
              type="number"
              required
              min={1}
              max={20}
              step={1}
              disabled={busy}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              className="ml-3 rounded-md border border-line p-2"
            />
          </label>
          {kind === 'room' && (
            <p className="text-sm text-muted">
              Name rooms separately with quantity 1 when adding beds/chairs inside them.
            </p>
          )}
          {kind !== 'room' && (
            <label className="block">
              Room
              <select
                disabled={busy}
                value={room}
                onChange={(event) => setRoom(event.target.value)}
                className="ml-3 rounded-md border border-line p-2"
              >
                <option value="">{kind === 'equipment' ? 'Portable' : 'Choose a room'}</option>
                {resources
                  .filter(
                    (item) => item.active && item.kind === 'room' && (item.quantity ?? 1) === 1,
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <div className="flex gap-4">
            <button
              disabled={busy || !name.trim()}
              type="submit"
              className="rounded-md bg-brand px-4 py-2 text-white"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button disabled={busy} type="button" onClick={() => setEditing(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {resources.length === 0 && (
        <p className="mt-4 text-muted">
          No resources configured. Current bookings still use staff availability.
        </p>
      )}
      <ul className="mt-4 divide-y divide-line">
        {resources.map((resource) => (
          <li key={resource.id} className="flex items-center justify-between gap-4 py-3">
            <div>
              <span className="font-medium">{resource.name}</span>
              <p className="text-sm text-muted">
                {resource.kind}
                {` · Quantity ${resource.quantity ?? 1}`}
                {resource.fixedRoomId
                  ? ` · ${resources.find((item) => item.id === resource.fixedRoomId)?.name ?? 'Fixed room'}`
                  : ''}
                {!resource.active ? ' · Retired' : ''}
              </p>
            </div>
            <div className="flex gap-4">
              <button disabled={busy} onClick={() => edit(resource)}>
                Edit
              </button>
              <button disabled={busy} onClick={() => toggle(resource)}>
                {resource.active ? 'Retire' : 'Restore'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-6 space-y-3 border-t border-line pt-5">
        <h3 className="font-semibold">Temporary downtime</h3>
        <p className="text-sm text-muted">
          Times in {timezone}. Existing appointments stay booked; check the affected appointments
          and move or cancel them deliberately.
        </p>
        {notice && (
          <p role="status" className="rounded-lg bg-surface p-3 text-sm">
            {notice}
          </p>
        )}
        <ul className="space-y-2">
          {blocks.map((block) => (
            <li
              key={block.id}
              className="flex flex-wrap items-center justify-between gap-3 text-sm"
            >
              <span>
                {resources.find((resource) => resource.id === block.resourceId)?.name ?? 'Resource'}{' '}
                · {formatWhen(block.startsAt, timezone)} – {formatWhen(block.endsAt, timezone)}
                {block.reason ? ` · ${block.reason}` : ''}
              </span>
              <button
                type="button"
                disabled={busy}
                className="min-h-11 underline"
                onClick={async () => {
                  if (!window.confirm('Remove this downtime and reopen these times for bookings?'))
                    return;
                  setBusy(true);
                  setError('');
                  try {
                    await removeResourceBlockAction(businessId, block.id);
                    router.refresh();
                  } catch {
                    setError('Could not remove downtime. Try again.');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Remove downtime
              </button>
            </li>
          ))}
        </ul>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            setNotice('');
            try {
              const result = await blockResourceAction(businessId, {
                resourceId: downtime,
                startsAt: start,
                endsAt: end,
                reason: reason.trim(),
              });
              setNotice(
                `${result.affectedBookings.length === 500 ? 'At least 500' : result.affectedBookings.length} appointments overlap this downtime. Check the calendar before making further changes.`,
              );
              setStart('');
              setEnd('');
              router.refresh();
            } catch {
              setError(
                'Could not block this resource. Choose a valid start and end within one year.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="grid gap-1 text-sm">
            Resource
            <select
              required
              disabled={busy}
              value={downtime}
              onChange={(event) => setDowntime(event.target.value)}
              className="min-h-11 rounded-lg border border-line px-3"
            >
              <option value="">Choose a resource</option>
              {resources
                .filter((resource) => resource.active)
                .map((resource) => (
                  <option key={resource.id} value={resource.id}>
                    {resource.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Reason
            <input
              disabled={busy}
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="min-h-11 rounded-lg border border-line px-3"
            />
          </label>
          <label className="grid gap-1 text-sm">
            From
            <input
              type="datetime-local"
              required
              disabled={busy}
              value={start}
              onChange={(event) => setStart(event.target.value)}
              className="min-h-11 rounded-lg border border-line px-3"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Until
            <input
              type="datetime-local"
              required
              disabled={busy}
              min={start || undefined}
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              className="min-h-11 rounded-lg border border-line px-3"
            />
          </label>
          <button
            disabled={busy || !downtime || !start || !end || end <= start}
            className="min-h-11 rounded-lg bg-brand px-4 text-white"
          >
            {busy ? 'Saving…' : 'Block resource'}
          </button>
        </form>
      </div>
    </section>
  );
}
