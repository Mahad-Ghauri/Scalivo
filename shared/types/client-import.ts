/**
 * Bulk customer import — milestone 2.7.
 *
 * The browser parses the CSV and maps its columns onto this shape; the server
 * validates, dedupes and writes. Every field but the phone is optional because
 * the lists businesses actually have range from a phone export with names to a
 * spreadsheet someone kept by hand, and refusing the first for lacking visit
 * counts would mean nobody imports anything.
 */

/** Per request. A larger list is sent in pages; one huge body is one huge failure. */
export const CLIENT_IMPORT_MAX_ROWS = 2000;

export interface ClientImportRow {
  name?: string | undefined;
  /** Required. The only thing a customer can be matched on later. */
  phone: string;
  /**
   * Completed visits before Scalivo. A string is accepted as the cell was typed
   * — the server reads it, so an unreadable one is reported against its row.
   */
  visits?: number | string | undefined;
  /** Lifetime spend before Scalivo, in rupees (major units): "Rs. 12,500" is fine. */
  spend?: number | string | undefined;
  /** 'YYYY-MM-DD' or 'DD/MM/YYYY' — the Pakistani order, never the American one. */
  firstVisit?: string | undefined;
  lastVisit?: string | undefined;
}

export type ClientImportOutcome =
  /** No such person on the platform yet. */
  | 'created'
  /** The person exists (e.g. messaged on WhatsApp) but not as this business's customer. */
  | 'linked'
  /** Already this business's customer; the imported history replaces any earlier import. */
  | 'updated'
  /** The same phone appeared earlier in this file. */
  | 'duplicate'
  | 'invalid';

export interface ClientImportRowResult {
  /** Index into the submitted rows, so the preview can point at the line. */
  row: number;
  outcome: ClientImportOutcome;
  /** Normalised, when it could be. */
  phone: string | null;
  /** Why the row was refused. Only on 'invalid' and 'duplicate'. */
  reason?: string;
  /**
   * On 'duplicate': the row it repeats. An index, not a sentence, because only
   * the page knows whether the file had a header line and how it numbers lines.
   */
  duplicateOf?: number;
}

export interface ClientImportResult {
  dryRun: boolean;
  counts: Record<ClientImportOutcome, number>;
  rows: ClientImportRowResult[];
}
