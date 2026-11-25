// `labels`: the text on the sheet, grouped or one by one. `tags`: riser tags
// paired with their sizes.

import type { CommandInput } from '../cli/table.ts';
import { readLegend } from '../drawing/legend.ts';
import { colorHex, type Label, type LabelSource } from '../drawing/model.ts';
import { sizeLabels } from '../drawing/sizes.ts';
import { findTags } from '../drawing/tags.ts';
import { usage } from '../errors.ts';
import { countLine, listOutput, plural, type Row } from '../output/views.ts';
import {
  areaOf,
  clipStrokes,
  inArea,
  NO_LAYER,
  openSheet,
  paperMm,
  positiveInt,
  save,
  str,
  wholeSheet,
} from './common.ts';

const SOURCES: readonly LabelSource[] = ['shx', 'text', 'note'];

function matcher(
  pattern: string | undefined,
): ((text: string) => boolean) | null {
  if (pattern === undefined) return null;
  if (pattern.length > 200) throw usage('--match is at most 200 characters.');
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'iu');
  } catch {
    throw usage(
      '--match is not a valid regular expression. Escape special characters such as ( ) [ ] . with a backslash.',
    );
  }
  return (text) => re.test(text);
}

function pickLabels(
  input: CommandInput,
  labels: readonly Label[],
  everySource = false,
) {
  const sourceFlag = str(input.values, 'source');
  if (
    sourceFlag !== undefined &&
    sourceFlag !== 'all' &&
    !SOURCES.includes(sourceFlag as LabelSource)
  )
    throw usage('--source is one of: shx, text, note, all.');
  const counts = { shx: 0, text: 0, note: 0 };
  for (const l of labels) counts[l.source]++;
  // A CAD plot's own labels are its stroke-font text; font text on such a
  // sheet is mostly the background plan, so a plain listing leaves it out.
  // A search, a size count and the tags look everywhere: a real label may be
  // in either.
  const searching = everySource || str(input.values, 'match') !== undefined;
  const auto =
    !searching && counts.shx + counts.note >= 20
      ? ['shx', 'note']
      : [...SOURCES];
  const sources = new Set<string>(
    sourceFlag === undefined
      ? auto
      : sourceFlag === 'all'
        ? SOURCES
        : [sourceFlag],
  );
  const area = areaOf(input.values);
  const test = matcher(str(input.values, 'match'));
  const picked = labels.filter(
    (l) =>
      sources.has(l.source) &&
      l.text !== '' &&
      inArea(area, (l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2) &&
      (!test || test(l.text)),
  );
  const left = SOURCES.filter((s) => !sources.has(s) && counts[s] > 0);
  return {
    picked,
    area,
    filtered: test !== null || !wholeSheet(area),
    hiddenNote:
      sourceFlag === undefined && left.length
        ? `${left.map((s) => `${counts[s]} ${s === 'text' ? 'font text' : s} labels`).join(' and ')} not shown; add --source all`
        : null,
  };
}

export function labels(input: CommandInput): string {
  const { sheet, name } = openSheet(input);
  const limit = positiveInt(input.values, 'limit', 20);
  const full = input.values.full === true;
  const { picked, filtered, hiddenNote } = pickLabels(
    input,
    sheet.labels,
    input.values.sizes === true,
  );
  const fontTextStatus = sheet.unreadableText
    ? {
        text_status: sheet.labels.some((l) => l.source === 'text')
          ? 'Some font text not readable in this PDF on the selected page. Ask for a PDF re-exported with selectable text.'
          : 'Font text not readable in this PDF on the selected page. Ask for a PDF re-exported with selectable text.',
      }
    : {};
  const head: Row = { file: name, also: hiddenNote, ...fontTextStatus };
  if (input.values.sizes === true) {
    // One row per way a size is written: with a system code, with a slope,
    // or alone. A size written alone belongs to a tag.
    const kinds = new Map<
      string,
      { code: string; size: string; slope: string; labels: number }
    >();
    for (const s of sizeLabels(picked)) {
      const slope = /-\s*(\d+(?:\.\d+)?)\s*%/.exec(s.text)?.[1];
      const key = `${s.code ?? ''}|${s.size}|${slope ?? ''}`;
      const e = kinds.get(key) ?? {
        code: s.code ?? '-',
        size: s.size,
        slope: slope ? `${slope}%` : '-',
        labels: 0,
      };
      e.labels++;
      kinds.set(key, e);
    }
    const rows: Row[] = [...kinds.values()].sort(
      (a, b) =>
        b.labels - a.labels ||
        a.size.localeCompare(b.size) ||
        a.code.localeCompare(b.code),
    );
    const saved = save(input.io, str(input.values, 'save'), {
      file: name,
      ...fontTextStatus,
      sizes: rows,
    });
    return listOutput({
      key: 'sizes',
      summary: rows.length
        ? `${plural(rows.length, 'way')} a pipe size is written, in ${plural(
            rows.reduce((s, r) => s + (r.labels as number), 0),
            'label',
          )}`
        : '0 labels name a pipe size',
      head: { ...head, saved },
      rows: full ? rows : rows.slice(0, limit),
      columns: ['code', 'size', 'slope', 'labels'],
      full,
      narrower: 'drawing-axi labels <file.pdf> --sizes --region <x0,y0,x1,y1>',
      help: rows.length
        ? [
            'Run `drawing-axi measure <file.pdf> --group <name>=<layer>` to put sizes on runs',
            'Run `drawing-axi tags <file.pdf>` for sizes written inside riser tags',
          ]
        : ['Run `drawing-axi labels <file.pdf>` for every label'],
    });
  }
  if (input.values.each === true) {
    const rows: Row[] = [...picked]
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
      .map((l) => ({
        text: l.text,
        x: Math.round((l.x0 + l.x1) / 2),
        y: Math.round((l.y0 + l.y1) / 2),
        source: l.source,
        // The stored text, where decoding changed it.
        ...(full ? { stored: l.raw.trim() === l.text ? null : l.raw } : {}),
      }));
    const saved = save(input.io, str(input.values, 'save'), {
      file: name,
      ...fontTextStatus,
      labels: rows,
    });
    const shown = full ? rows : rows.slice(0, limit);
    return listOutput({
      key: 'labels',
      summary: rows.length
        ? `${countLine(shown.length, rows.length, 'label')}${filtered ? ' matching' : ''}, top of the sheet first`
        : `0 labels${filtered ? ' match' : ''}`,
      head: { ...head, saved },
      rows: shown,
      columns: full
        ? ['text', 'x', 'y', 'source', 'stored']
        : ['text', 'x', 'y', 'source'],
      full,
      narrower: 'drawing-axi labels <file.pdf> --each --region <x0,y0,x1,y1>',
      help: rows.length
        ? [
            'Run `drawing-axi render <file.pdf> --region <x0,y0,x1,y1> --labels --out <file.png>` to see a label in its place',
          ]
        : [
            'Run `drawing-axi labels <file.pdf>` without filters for every label',
          ],
    });
  }
  const groups = new Map<string, { count: number; first: Label }>();
  for (const l of picked) {
    const g = groups.get(l.text);
    if (g) g.count++;
    else groups.set(l.text, { count: 1, first: l });
  }
  const rows: Row[] = [...groups]
    .map(([text, g]) => ({
      text,
      count: g.count,
      at: `${Math.round((g.first.x0 + g.first.x1) / 2)},${Math.round((g.first.y0 + g.first.y1) / 2)}`,
    }))
    .sort(
      (a, b) =>
        b.count - a.count || String(a.text).localeCompare(String(b.text)),
    );
  const saved = save(input.io, str(input.values, 'save'), {
    file: name,
    ...fontTextStatus,
    labels: rows,
  });
  const shown = full ? rows : rows.slice(0, limit);
  return listOutput({
    key: 'labels',
    summary: rows.length
      ? `${countLine(shown.length, rows.length, 'different label')} from ${plural(picked.length, 'label')}${filtered ? ' matching' : ''}, most frequent first`
      : `0 labels${filtered ? ' match' : ''}`,
    head: { ...head, saved },
    rows: shown,
    columns: ['text', 'count', 'at'],
    full,
    narrower: 'drawing-axi labels <file.pdf> --match <text>',
    help: rows.length
      ? [
          'Run `drawing-axi labels <file.pdf> --match <text> --each` for where each one is',
          'Run `drawing-axi labels <file.pdf> --sizes` for the pipe sizes the labels name',
        ]
      : ['Run `drawing-axi labels <file.pdf>` without filters for every label'],
  });
}

export function tags(input: CommandInput): string {
  const { sheet, name } = openSheet(input);
  const limit = positiveInt(input.values, 'limit', 20);
  const full = input.values.full === true;
  const { picked } = pickLabels(input, sheet.labels, true);
  const found = findTags(picked);
  const places = found.map((t) => ({
    tag: t.id,
    series: t.series,
    size: t.size,
    x: Math.round(t.x),
    y: Math.round(t.y),
  }));
  const help = found.length
    ? [
        'Run `drawing-axi tags <file.pdf> --each` for where each tag is',
        'Run `drawing-axi labels <file.pdf> --match <text>` to read what a series means in the legend',
      ]
    : [
        'Run `drawing-axi labels <file.pdf> --sizes` for the sizes the sheet names in other ways',
      ];
  if (input.values.each === true) {
    const rows: Row[] = found
      .map((t) => ({
        tag: t.id,
        size: t.size,
        x: Math.round(t.x),
        y: Math.round(t.y),
      }))
      .sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
    const saved = save(input.io, str(input.values, 'save'), {
      file: name,
      tags: places,
    });
    const shown = full ? rows : rows.slice(0, limit);
    return listOutput({
      key: 'tags',
      summary: rows.length
        ? `${countLine(shown.length, rows.length, 'tag')} with a size`
        : '0 tags with a size',
      head: { file: name, saved },
      rows: shown,
      columns: ['tag', 'size', 'x', 'y'],
      full,
      narrower: 'drawing-axi tags <file.pdf> --each --region <x0,y0,x1,y1>',
      help,
    });
  }
  const groups = new Map<
    string,
    { series: string; size: string; ids: string[] }
  >();
  for (const t of found) {
    const key = `${t.series}|${t.size}`;
    const g = groups.get(key);
    if (g) g.ids.push(t.id);
    else groups.set(key, { series: t.series, size: t.size, ids: [t.id] });
  }
  const rows: Row[] = [...groups.values()]
    .map((g) => ({
      series: g.series,
      size: g.size,
      count: g.ids.length,
      tags: g.ids
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .join(' '),
    }))
    .sort(
      (a, b) =>
        a.series.localeCompare(b.series) || a.size.localeCompare(b.size),
    );
  const saved = save(input.io, str(input.values, 'save'), {
    file: name,
    tags: rows,
    places,
  });
  const shown = full ? rows : rows.slice(0, limit);
  return listOutput({
    key: 'tags',
    summary: rows.length
      ? `${plural(found.length, 'tag')} with a size, in ${countLine(shown.length, rows.length, 'series and size', 'series and sizes')}`
      : '0 tags with a size: the sheet marks no identifier with a size beside it',
    head: { file: name, saved },
    rows: shown,
    columns: ['series', 'size', 'count', 'tags'],
    full,
    narrower: 'drawing-axi tags <file.pdf> --region <x0,y0,x1,y1>',
    help,
  });
}

export function legend(input: CommandInput): string {
  const { sheet, name } = openSheet(input);
  const limit = positiveInt(input.values, 'limit', 40);
  const full = input.values.full === true;
  const { picked, area } = pickLabels(input, sheet.labels);
  const entries = readLegend(clipStrokes(sheet.strokes, area), picked, {
    gap: paperMm(8),
    minSample: paperMm(4),
    maxSample: paperMm(60),
    reach: paperMm(110),
    // Inside a box the caller drew round the legend, every row counts.
    aligned: wholeSheet(area),
  });
  const rows: Row[] = entries.map((e) => ({
    text: e.text,
    layer: sheet.layers[e.layer]?.name ?? NO_LAYER,
    color: colorHex(e.color),
    at: `${Math.round(e.x)},${Math.round(e.y)}`,
  }));
  // The box round the captions and their samples: what a takeoff leaves out.
  const box = entries.length
    ? [
        Math.floor(Math.min(...entries.map((e) => e.x0)) - 10),
        Math.floor(Math.min(...entries.map((e) => e.y0)) - 10),
        Math.ceil(Math.max(...entries.map((e) => e.x1)) + 10),
        Math.ceil(Math.max(...entries.map((e) => e.y1)) + 10),
      ].join(',')
    : null;
  const saved = save(input.io, str(input.values, 'save'), {
    file: name,
    box,
    legend: rows,
  });
  const shown = full ? rows : rows.slice(0, limit);
  return listOutput({
    key: 'legend',
    summary: rows.length
      ? `${countLine(shown.length, rows.length, 'legend line')} paired with the layer its sample is drawn on`
      : '0 legend lines found: no caption has a sample line beside it',
    head: { file: name, box, saved },
    rows: shown,
    columns: ['text', 'layer', 'color', 'at'],
    full,
    narrower: 'drawing-axi legend <file.pdf> --region <x0,y0,x1,y1>',
    help: rows.length
      ? [
          'Run `drawing-axi measure <file.pdf> --group <name>=<layer> --group <name>=<layer> --exclude <box>` with these layers, one group per system and the box left out',
          'Run `drawing-axi layers <file.pdf>` for layers the legend does not name',
        ]
      : [
          'Run `drawing-axi labels <file.pdf> --match <legend word> --each` to find the legend, then `drawing-axi legend <file.pdf> --region <x0,y0,x1,y1>` round it',
          'Run `drawing-axi layers <file.pdf>` to tell systems apart by layer name and colour',
        ],
  });
}
