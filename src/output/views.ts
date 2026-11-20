// The two shapes every command prints: a list with a summary line, and a
// single record. Both stay inside the size bounds of src/output/toon.ts.

import { bounded, cut, render } from './toon.ts';

export type Row = Record<string, unknown>;

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "20 of 164 layers", or "3 layers" when every row is shown. */
export function countLine(
  shown: number,
  total: number,
  noun: string,
  nouns = `${noun}s`,
): string {
  if (total === shown) return plural(total, noun, nouns);
  return `${shown} of ${total} ${total === 1 ? noun : nouns}`;
}

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0);

/** A table row: exactly `columns`, empty values as null, so TOON keeps the tabular form. */
export function tableRow(
  row: Row,
  columns: readonly string[],
  fieldLimit: number,
): Row {
  const out: Row = {};
  for (const name of columns) {
    const v = row[name];
    out[name] = isEmpty(v)
      ? null
      : typeof v === 'string' && Number.isFinite(fieldLimit)
        ? cut(v, fieldLimit)
        : v;
  }
  return out;
}

/** Drop empty values and cut long strings, recursively, for a record view. */
export function compact(value: unknown, fieldLimit: number): unknown {
  if (typeof value === 'string')
    return Number.isFinite(fieldLimit) ? cut(value, fieldLimit) : value;
  if (Array.isArray(value)) return value.map((v) => compact(v, fieldLimit));
  if (value && typeof value === 'object') {
    const out: Row = {};
    for (const [k, v] of Object.entries(value)) {
      if (isEmpty(v)) continue;
      out[k] = compact(v, fieldLimit);
    }
    return out;
  }
  return value;
}

export interface ListView {
  /** The key the rows are printed under. */
  key: string;
  /** What the list is, with its counts: "20 of 143 layers". */
  summary: string;
  /** Fields printed before the rows. */
  head?: Row;
  rows: Row[];
  columns: readonly string[];
  help: readonly string[];
  full: boolean;
  /** A narrower command, named when even --full is too large. */
  narrower: string;
}

/** A list bounded to the default output size: long fields are cut, then rows are dropped and counted. */
export function listOutput(view: ListView): string {
  return bounded(
    {
      total: view.rows.length,
      narrower: view.narrower,
      build: (shown, fieldLimit) => {
        const dropped = view.rows.length - shown;
        const doc: Row = {
          summary: dropped
            ? `${view.summary}; the last ${dropped} left out to fit, use --limit or --save`
            : view.summary,
          ...(compact(view.head ?? {}, fieldLimit) as Row),
        };
        doc[view.key] = view.rows
          .slice(0, shown)
          .map((r) => tableRow(r, view.columns, fieldLimit));
        return render(doc, view.help);
      },
    },
    view.full,
  );
}

/** A single record: empty values dropped, long text cut unless --full. */
export function recordOutput(
  doc: Row,
  full: boolean,
  narrower: string,
  help: readonly string[] = [],
): string {
  return bounded(
    {
      total: 1,
      narrower,
      build: (_shown, fieldLimit) =>
        render(compact(doc, fieldLimit) as Row, help),
    },
    full,
  );
}
