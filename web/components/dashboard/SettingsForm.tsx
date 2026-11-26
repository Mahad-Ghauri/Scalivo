'use client';

import { useMemo, useState, useTransition } from 'react';
import { updateSettingsAction } from '@/app/(dashboard)/dashboard/[businessId]/settings/actions';

/** The slice of GET /businesses/:id this form edits. */
export interface EditableBusiness {
  slug: string;
  name: string;
  city: string | null;
  timezone: string;
  slotIncrementMinutes: number;
  minNoticeMinutes: number;
  bookingHorizonDays: number;
  published: boolean;
  reminders?: {
    enabled?: boolean;
    leadMinutes?: number[];
    escalate?: boolean;
    escalateMinutesBefore?: number;
  };
  profile?: {
    tagline?: string;
    about?: string;
    neighbourhood?: string | null;
    addressLine?: string | null;
    logoUrl?: string | null;
    coverUrl?: string | null;
    themeColor?: string | null;
  };
}

const SLOT_SIZES = [5, 10, 15, 30];

/** The backend allows four reminders; these are the leads owners actually pick. */
const MAX_REMINDERS = 4;
const LEAD_PRESETS = [2880, 1440, 180, 120, 60, 30];

function leadLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'} before`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'} before`;
  return `${minutes} minutes before`;
}

const input =
  'w-full rounded-md border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-60';

export function SettingsForm({
  businessId,
  business,
}: {
  businessId: string;
  business: EditableBusiness;
}) {
  const [pending, startTransition] = useTransition();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const [name, setName] = useState(business.name);
  const [city, setCity] = useState(business.city ?? '');
  const [timezone, setTimezone] = useState(business.timezone);

  const [tagline, setTagline] = useState(business.profile?.tagline ?? '');
  const [about, setAbout] = useState(business.profile?.about ?? '');
  const [neighbourhood, setNeighbourhood] = useState(business.profile?.neighbourhood ?? '');
  const [addressLine, setAddressLine] = useState(business.profile?.addressLine ?? '');
  const [logoUrl, setLogoUrl] = useState(business.profile?.logoUrl ?? '');
  const [coverUrl, setCoverUrl] = useState(business.profile?.coverUrl ?? '');
  const [themeColor, setThemeColor] = useState(business.profile?.themeColor ?? '');

  const [slotSize, setSlotSize] = useState(business.slotIncrementMinutes);
  const [minNotice, setMinNotice] = useState(String(business.minNoticeMinutes));
  const [horizon, setHorizon] = useState(String(business.bookingHorizonDays));

  const [remindersOn, setRemindersOn] = useState(business.reminders?.enabled ?? true);
  const [leads, setLeads] = useState<number[]>(business.reminders?.leadMinutes ?? []);
  const [escalate, setEscalate] = useState(business.reminders?.escalate ?? true);
  const [escalateBefore, setEscalateBefore] = useState(business.reminders?.escalateMinutesBefore ?? 180);

  const [published, setPublished] = useState(business.published);
  const [blockers, setBlockers] = useState<string[]>([]);

  // Every zone the browser knows, plus the stored one in case it does not.
  const zones = useMemo(() => {
    const known = Intl.supportedValuesOf('timeZone');
    return known.includes(business.timezone) ? known : [business.timezone, ...known];
  }, [business.timezone]);

  // A lead the owner already has stays listed even when it is not a preset,
  // or saving the form would silently delete it.
  const leadOptions = useMemo(
    () => [...new Set([...LEAD_PRESETS, ...(business.reminders?.leadMinutes ?? [])])].sort((a, b) => b - a),
    [business.reminders?.leadMinutes],
  );

  function toggleLead(minutes: number) {
    setLeads((current) =>
      current.includes(minutes) ? current.filter((m) => m !== minutes) : [...current, minutes],
    );
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);

    const payload = {
      name,
      city,
      timezone,
      slotIncrementMinutes: slotSize,
      minNoticeMinutes: Number(minNotice),
      bookingHorizonDays: Number(horizon),
      reminders: {
        enabled: remindersOn,
        leadMinutes: leads,
        escalate,
        escalateMinutesBefore: escalateBefore,
      },
      profile: { tagline, about, neighbourhood, addressLine, logoUrl, coverUrl, themeColor },
    };

    startTransition(async () => {
      const result = await updateSettingsAction(businessId, payload);
      if (result.ok) {
        setFields({});
        setNotice({ tone: 'ok', text: 'Saved.' });
      } else {
        setFields(result.fields);
        setNotice({ tone: 'error', text: 'Some settings were not saved — see the highlighted fields.' });
      }
    });
  }

  function setVisibility(next: boolean) {
    setBlockers([]);
    startTransition(async () => {
      const result = await updateSettingsAction(businessId, { published: next });
      if (result.ok) setPublished(next);
      else setBlockers(result.blockers.length > 0 ? result.blockers : [result.error]);
    });
  }

  const error = (key: string) =>
    fields[key] ? <p className="mt-1 text-[13px] text-red-600">{fields[key]}</p> : null;

  return (
    <div className="space-y-6 pb-24">
      <Section
        title="Marketplace listing"
        caption={
          published
            ? 'Your profile is live — customers can find and book you on the web.'
            : 'Hidden. Nobody can find you on the marketplace until you publish.'
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[13px] font-semibold ${
              published ? 'bg-emerald-50 text-emerald-800' : 'bg-surface text-muted'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${published ? 'bg-emerald-600' : 'bg-muted'}`}
            />
            {published ? 'Live' : 'Hidden'}
          </span>
          {published && (
            <a href={`/${business.slug}`} target="_blank" rel="noreferrer" className="text-[14px] font-medium text-brand hover:underline">
              View your profile
            </a>
          )}
          <button
            type="button"
            onClick={() => setVisibility(!published)}
            disabled={pending}
            className={`ml-auto rounded-full px-4 py-2 text-[14px] font-semibold disabled:opacity-60 ${
              published ? 'border border-line text-ink hover:bg-surface' : 'bg-ink text-white hover:bg-ink/90'
            }`}
          >
            {published ? 'Hide from marketplace' : 'Publish'}
          </button>
        </div>

        {blockers.length > 0 && (
          <div className="mt-4 rounded-md bg-amber-50 p-4 text-[14px] text-amber-900">
            <p className="font-semibold">Not ready to publish yet:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
            <p className="mt-2 text-[13px]">A tagline or city typed below needs saving first.</p>
          </div>
        )}
      </Section>

      <form onSubmit={save} className="space-y-6">
        <Section title="Business">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business name" error={error('name')}>
              <input className={input} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
            </Field>
            <Field label="City" error={error('city')}>
              <input className={input} value={city} onChange={(e) => setCity(e.target.value)} required maxLength={80} placeholder="e.g. Lahore" />
            </Field>
            <Field
              label="Timezone"
              hint="Every appointment time, reminder and report is in this zone."
              error={error('timezone')}
            >
              <select className={input} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Section>

        <Section title="Public profile" caption="What customers see on your marketplace page.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tagline" hint="One line under your name in search results." error={error('profile.tagline')} wide>
              <input className={input} value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={120} placeholder="e.g. Hydrafacials and laser in DHA" />
            </Field>
            <Field label="About" error={error('profile.about')} wide>
              <textarea className={`${input} min-h-28`} value={about} onChange={(e) => setAbout(e.target.value)} maxLength={2000} />
            </Field>
            <Field label="Neighbourhood" error={error('profile.neighbourhood')}>
              <input className={input} value={neighbourhood} onChange={(e) => setNeighbourhood(e.target.value)} maxLength={80} placeholder="e.g. DHA Phase 5" />
            </Field>
            <Field label="Address" error={error('profile.addressLine')}>
              <input className={input} value={addressLine} onChange={(e) => setAddressLine(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Logo image link" hint="Must start with https://" error={error('profile.logoUrl')}>
              <input className={input} type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://" />
            </Field>
            <Field label="Cover image link" hint="Must start with https://" error={error('profile.coverUrl')}>
              <input className={input} type="url" value={coverUrl} onChange={(e) => setCoverUrl(e.target.value)} placeholder="https://" />
            </Field>
            <Field label="Accent colour" hint="Leave blank for the default." error={error('profile.themeColor')}>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick accent colour"
                  className="h-9 w-12 shrink-0 cursor-pointer rounded border border-line bg-white"
                  value={themeColor || '#000000'}
                  onChange={(e) => setThemeColor(e.target.value)}
                />
                <input className={input} value={themeColor} onChange={(e) => setThemeColor(e.target.value)} placeholder="#1a2b3c" maxLength={7} />
              </div>
            </Field>
          </div>
        </Section>

        <Section title="Booking window" caption="Applies to WhatsApp and web bookings alike.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Slot size"
              hint="Can't change while there are upcoming bookings."
              error={error('slotIncrementMinutes')}
            >
              <select className={input} value={slotSize} onChange={(e) => setSlotSize(Number(e.target.value))}>
                {SLOT_SIZES.map((size) => (
                  <option key={size} value={size}>
                    Every {size} minutes
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Minimum notice (minutes)" hint="Nothing bookable sooner than this." error={error('minNoticeMinutes')}>
              <input className={input} type="number" min={0} max={10080} value={minNotice} onChange={(e) => setMinNotice(e.target.value)} required />
            </Field>
            <Field label="Book up to (days ahead)" error={error('bookingHorizonDays')}>
              <input className={input} type="number" min={1} max={365} value={horizon} onChange={(e) => setHorizon(e.target.value)} required />
            </Field>
          </div>
        </Section>

        <Section title="Reminders" caption="Sent over WhatsApp before each appointment.">
          <label className="flex items-center gap-2 text-[14px] font-medium text-ink">
            <input type="checkbox" className="rounded text-brand focus:ring-brand" checked={remindersOn} onChange={(e) => setRemindersOn(e.target.checked)} />
            Send appointment reminders
          </label>

          <fieldset disabled={!remindersOn} className="mt-4 disabled:opacity-50">
            <legend className="text-[13px] text-muted">Up to {MAX_REMINDERS}. Each is sent once per appointment.</legend>
            <div className="mt-3 flex flex-wrap gap-2">
              {leadOptions.map((minutes) => {
                const checked = leads.includes(minutes);
                return (
                  <label
                    key={minutes}
                    className={`cursor-pointer rounded-full border px-3.5 py-1.5 text-[14px] font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand ${
                      checked ? 'border-ink bg-ink text-white' : 'border-line bg-white text-muted hover:text-ink'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      disabled={!checked && leads.length >= MAX_REMINDERS}
                      onChange={() => toggleLead(minutes)}
                    />
                    {leadLabel(minutes)}
                  </label>
                );
              })}
            </div>
            {error('reminders.leadMinutes')}

            <label className="mt-5 flex items-center gap-2 text-[14px] font-medium text-ink">
              <input
                type="checkbox"
                className="rounded text-brand focus:ring-brand"
                checked={escalate}
                onChange={(e) => setEscalate(e.target.checked)}
              />
              Alert me when a customer hasn&apos;t confirmed
            </label>
            <p className="mt-1 text-[13px] text-muted">
              Reminders ask customers to reply 1 to confirm. You get a push if they stay silent, or
              straight away if the reminder never reaches them.
            </p>
            <label className="mt-3 flex items-center gap-2 text-[14px] text-ink">
              Alert
              <select
                className="rounded-md border border-line px-2 py-1 text-[14px] disabled:opacity-50"
                value={escalateBefore}
                disabled={!escalate}
                onChange={(e) => setEscalateBefore(Number(e.target.value))}
              >
                {[...new Set([60, 120, 180, 240, 360, escalateBefore])]
                  .sort((a, b) => a - b)
                  .map((m) => (
                    <option key={m} value={m}>
                      {leadLabel(m)}
                    </option>
                  ))}
              </select>
              the appointment
            </label>
            {error('reminders.escalateMinutesBefore')}
          </fieldset>
        </Section>

        <div className="sticky bottom-0 -mx-5 flex items-center gap-4 border-t border-line bg-white/95 px-5 py-4 backdrop-blur md:-mx-8 md:px-8">
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-ink px-6 py-2.5 text-[15px] font-semibold text-white hover:bg-ink/90 disabled:opacity-60"
          >
            {pending ? 'Saving…' : 'Save changes'}
          </button>
          {notice && (
            <p role="status" className={`text-[14px] ${notice.tone === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>
              {notice.text}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}

function Section({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
      <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
      {caption && <p className="mt-0.5 text-[14px] text-muted">{caption}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  error: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-[13px] text-muted">{hint}</span>}
      {error}
    </label>
  );
}
