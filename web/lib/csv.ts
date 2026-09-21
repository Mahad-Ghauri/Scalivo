/**
 * A CSV reader for the one file shape owners actually have: an Excel or Google
 * Sheets export, or a phone's contact export.
 *
 * Small enough to own rather than add a dependency for, but it does the parts
 * that break naive `split(',')` on real files: quoted fields holding commas
 * ("Khan, Sana"), doubled quotes inside them, CRLF line endings, Excel's BOM,
 * and semicolon-delimited files from machines with a European locale.
 */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const firstLine = source.slice(0, source.search(/\r?\n|$/));
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Trailing blank lines and rows of empty cells are what spreadsheets pad with.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}
