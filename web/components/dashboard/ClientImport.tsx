'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  CLIENT_IMPORT_MAX_ROWS,
  type ClientImportOutcome,
  type ClientImportResult,
  type ClientImportRow,
} from '@scalivo/shared';
import { parseCsv } from '@/lib/csv';
import { importClientsAction } from '@/app/(dashboard)/dashboard/[businessId]/customers/import/actions';

/**
 * Upload → map columns → preview → import.
 *
 * The preview is not optional. It runs the server's real validation and
 * matching with nothing written, so a wrong column choice ("that was the
 * landline column") shows up as 400 invalid rows on screen instead of as 400
 * customers nobody can message.
 */

const FIELDS = [
  { key: 'phone', label: 'Phone number', required: true, guess: /phone|mobile|cell|whatsapp|contact|^number$/i },
  { key: 'name', label: 'Name', required: false, guess: /name/i },
  { key: 'visits', label: 'Number of visits', required: false, guess: /visits|times/i },
  { key: 'spend', label: 'Total spent (PKR)', required: false, guess: /spen|amount|total|revenue|paid/i },
  { key: 'firstVisit', label: 'First visit date', required: false, guess: /first.*(visit|date)|since/i },
  { key: 'lastVisit', label: 'Last visit date', required: false, guess: /last.*(visit|date|seen)|recent/i },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];
type Mapping = Record<FieldKey, number>;

const NONE = -1;

const OUTCOMES: { key: ClientImportOutcome; label: string; tone: string }[] = [
  { key: 'created', label: 'New customers', tone: 'text-ink' },
  { key: 'linked', label: 'Already messaged you on WhatsApp', tone: 'text-ink' },
  { key: 'updated', label: 'Already your customers, history updated', tone: 'text-ink' },
  { key: 'duplicate', label: 'Repeated in the file', tone: 'text-amber-700' },
  { key: 'invalid', label: "Can't be imported", tone: 'text-red-700' },
];

function guessMapping(header: string[]): Mapping {
  const taken = new Set<number>();
  const mapping = {} as Mapping;
  for (const field of FIELDS) {
    const index = header.findIndex((h, i) => !taken.has(i) && field.guess.test(h));
    mapping[field.key] = index;
    if (index !== NONE) taken.add(index);
  }
  return mapping;
}

export function ClientImport({ businessId }: { businessId: string }) {
  const [pending, startTransition] = useTransition();
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<string[][]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [preview, setPreview] = useState<ClientImportResult | null>(null);
  const [done, setDone] = useState<ClientImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const header = hasHeader ? (table[0] ?? []) : (table[0] ?? []).map((_, i) => `Column ${i + 1}`);
  const body = hasHeader ? table.slice(1) : table;
  // What the owner sees in their spreadsheet: line 1 is the header.
  const lineOf = (row: number) => row + (hasHeader ? 2 : 1);

  async function onFile(file: File | undefined) {
    setPreview(null);
    setDone(null);
    setError(null);
    if (!file) return;

    const parsed = parseCsv(await file.text());
    if (parsed.length === 0) {
      setError('That file has no rows in it.');
      return;
    }
    setFileName(file.name);
    setTable(parsed);
    setMapping(guessMapping(parsed[0]!));
  }

  function rows(): ClientImportRow[] {
    const cell = (line: string[], key: FieldKey) => {
      const index = mapping?.[key] ?? NONE;
      return index === NONE ? undefined : (line[index]?.trim() || undefined);
    };
    // Numbers stay as typed: the server strips "Rs." and thousands separators,
    // and reports anything it cannot read against the right row.
    return body.map((line) => ({
      phone: cell(line, 'phone') ?? '',
      name: cell(line, 'name'),
      visits: cell(line, 'visits'),
      spend: cell(line, 'spend'),
      firstVisit: cell(line, 'firstVisit'),
      lastVisit: cell(line, 'lastVisit'),
    }));
  }

  /**
   * Sent in pages the server accepts, and stitched back into one result.
   *
   * Duplicates are detected within a page, so in a file over 2,000 rows the
   * same number in two pages is not flagged — the later row's history simply
   * replaces the earlier one's, which is safe, just not reported.
   */
  function run(dryRun: boolean) {
    setError(null);
    startTransition(async () => {
      const all = rows();
      const merged: ClientImportResult = {
        dryRun,
        counts: { created: 0, linked: 0, updated: 0, duplicate: 0, invalid: 0 },
        rows: [],
      };

      for (let start = 0; start < all.length; start += CLIENT_IMPORT_MAX_ROWS) {
        const response = await importClientsAction(
          businessId,
          all.slice(start, start + CLIENT_IMPORT_MAX_ROWS),
          dryRun,
        );
        if (!response.ok) {
          setError(
            start === 0
              ? response.error
              : `Stopped after ${start} rows: ${response.error}. The rows before that were imported; running the import again is safe.`,
          );
          return;
        }
        for (const key of Object.keys(merged.counts) as ClientImportOutcome[]) {
          merged.counts[key] += response.result.counts[key];
        }
        merged.rows.push(
          ...response.result.rows.map((r) => ({
            ...r,
            row: r.row + start,
            ...(r.duplicateOf !== undefined ? { duplicateOf: r.duplicateOf + start } : {}),
          })),
        );
      }

      if (dryRun) setPreview(merged);
      else {
        setDone(merged);
        setPreview(null);
      }
    });
  }

  function remap(key: FieldKey, index: number) {
    setMapping((current) => (current ? { ...current, [key]: index } : current));
    setPreview(null);
  }

  if (done) {
    const imported = done.counts.created + done.counts.linked + done.counts.updated;
    return (
      <Card>
        <h2 className="text-[18px] font-semibold text-ink">
          {imported} customer{imported === 1 ? '' : 's'} imported
        </h2>
        <p className="mt-1 text-[15px] text-muted">
          {done.counts.created} new, {done.counts.linked} matched to people who had already messaged
          you, {done.counts.updated} updated.
          {done.counts.invalid + done.counts.duplicate > 0 &&
            ` ${done.counts.invalid + done.counts.duplicate} rows were skipped.`}
        </p>
        <div className="mt-5 flex gap-3">
          <Link
            href={`/dashboard/${businessId}/customers`}
            className="rounded-full bg-ink px-5 py-2.5 text-[15px] font-semibold text-white hover:bg-ink/90"
          >
            View customers
          </Link>
          <button
            type="button"
            onClick={() => {
              setDone(null);
              setTable([]);
              setFileName(null);
              setMapping(null);
            }}
            className="rounded-full border border-line px-5 py-2.5 text-[15px] font-semibold text-ink hover:bg-surface"
          >
            Import another file
          </button>
        </div>
      </Card>
    );
  }

  const importable = preview ? preview.counts.created + preview.counts.linked + preview.counts.updated : 0;
  const problems = preview?.rows.filter((r) => r.outcome === 'invalid' || r.outcome === 'duplicate') ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <Step n={1} title="Choose a CSV file" />
        <p className="mt-1 text-[14px] text-muted">
          In Excel or Google Sheets: File → Download / Save as → CSV. Only a phone number is
          required; dates can be written 14/03/2026 or 2026-03-14.
        </p>
        <label className="mt-4 inline-flex cursor-pointer items-center gap-3 rounded-full border border-line px-4 py-2 text-[14px] font-semibold text-ink hover:bg-surface has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand">
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {fileName ? 'Choose a different file' : 'Choose file'}
        </label>
        {fileName && (
          <span className="ml-3 text-[14px] text-muted">
            {fileName} · {body.length} row{body.length === 1 ? '' : 's'}
          </span>
        )}
        {error && <p className="mt-3 text-[14px] text-red-600">{error}</p>}
      </Card>

      {mapping && (
        <Card>
          <Step n={2} title="Match your columns" />
          <label className="mt-3 flex items-center gap-2 text-[14px] text-ink">
            <input
              type="checkbox"
              className="rounded text-brand focus:ring-brand"
              checked={hasHeader}
              onChange={(e) => {
                setHasHeader(e.target.checked);
                setPreview(null);
              }}
            />
            The first row is column names
          </label>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((field) => (
              <label key={field.key} className="block">
                <span className="mb-1 block text-sm font-medium text-ink">
                  {field.label}
                  {field.required && <span className="text-red-600"> *</span>}
                </span>
                <select
                  className="w-full rounded-md border border-line px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  value={mapping[field.key]}
                  onChange={(e) => remap(field.key, Number(e.target.value))}
                >
                  <option value={NONE}>{field.required ? 'Choose a column' : "Don't import"}</option>
                  {header.map((name, index) => (
                    <option key={index} value={index}>
                      {name || `Column ${index + 1}`}
                      {body[0]?.[index] ? ` (e.g. ${body[0][index]})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <button
            type="button"
            onClick={() => run(true)}
            disabled={pending || mapping.phone === NONE || body.length === 0}
            className="mt-6 rounded-full bg-ink px-5 py-2.5 text-[15px] font-semibold text-white hover:bg-ink/90 disabled:opacity-50"
          >
            {pending && !preview ? 'Checking…' : 'Check the file'}
          </button>
        </Card>
      )}

      {preview && (
        <Card>
          <Step n={3} title="Review and import" />
          <p className="mt-1 text-[14px] text-muted">Nothing has been saved yet.</p>

          <dl className="mt-4 divide-y divide-line rounded-lg border border-line">
            {OUTCOMES.filter((o) => preview.counts[o.key] > 0).map((o) => (
              <div key={o.key} className="flex items-center justify-between px-4 py-2.5 text-[14px]">
                <dt className={o.tone}>{o.label}</dt>
                <dd className="tabular-nums font-semibold text-ink">{preview.counts[o.key]}</dd>
              </div>
            ))}
          </dl>

          {problems.length > 0 && (
            <details className="mt-4" open={problems.length <= 10}>
              <summary className="cursor-pointer text-[14px] font-medium text-ink">
                Rows that will be skipped ({problems.length})
              </summary>
              <table className="mt-3 w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th scope="col" className="py-1.5 pr-4 font-medium">Line</th>
                    <th scope="col" className="py-1.5 font-medium">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {problems.slice(0, 100).map((r) => (
                    <tr key={r.row} className="border-b border-line/60">
                      <td className="py-1.5 pr-4 tabular-nums text-muted">{lineOf(r.row)}</td>
                      <td className="py-1.5 text-ink">
                        {r.duplicateOf !== undefined
                          ? `Same number as line ${lineOf(r.duplicateOf)}`
                          : r.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {problems.length > 100 && (
                <p className="mt-2 text-[13px] text-muted">…and {problems.length - 100} more.</p>
              )}
            </details>
          )}

          <button
            type="button"
            onClick={() => run(false)}
            disabled={pending || importable === 0}
            className="mt-6 rounded-full bg-ink px-5 py-2.5 text-[15px] font-semibold text-white hover:bg-ink/90 disabled:opacity-50"
          >
            {pending ? 'Importing…' : `Import ${importable} customer${importable === 1 ? '' : 's'}`}
          </button>
        </Card>
      )}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="rounded-xl border border-line bg-white p-6 shadow-sm">{children}</section>;
}

function Step({ n, title }: { n: number; title: string }) {
  return (
    <h2 className="flex items-center gap-2.5 text-[16px] font-semibold text-ink">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[12px] text-white">
        {n}
      </span>
      {title}
    </h2>
  );
}
