// `runs`: the straight runs on chosen layers. `measure`: their length by
// group and pipe size, the table a bill of quantities is built from.

import type { CommandInput } from '../cli/table.ts';
import type { Label, Sheet } from '../drawing/model.ts';
import { buildRuns, dropShadows, segmentsOf } from '../drawing/runs.ts';
import {
  codeOf,
  type GroupedRun,
  type SizedRun,
  type SizeLabel,
  sizeLabels,
  sizeRuns,
} from '../drawing/sizes.ts';
import { findTags } from '../drawing/tags.ts';
import { usage } from '../errors.ts';
import { bounded, render } from '../output/toon.ts';
import {
  countLine,
  listOutput,
  plural,
  type Row,
  tableRow,
} from '../output/views.ts';
import {
  type Area,
  areaOf,
  clipStrokes,
  inArea,
  type LayerPick,
  LETTER_GAPS,
  linetypeLetters,
  list,
  openSheet,
  PICTURE_NOTE,
  paperMm,
  percent,
  pickLayer,
  pickLayers,
  positiveInt,
  positiveNumber,
  round,
  save,
  scaleOf,
  str,
  strokesOf,
  wholeSheet,
} from './common.ts';
import { scaleLine } from './info.ts';

interface Group {
  name: string;
  picks: LayerPick[];
}

/** A group's name is the caller's own words: anything printable, up to 60 characters. */
const GROUP_NAME = /^[^=\p{Cc}\p{Cf}]{1,60}$/u;

/** `--group name=LAYER[@colour][+LAYER...]` and `--layer LAYER[@colour]`. */
function groupsOf(input: CommandInput, sheet: Sheet): Group[] {
  const groups: Group[] = [];
  const add = (name: string, picks: LayerPick[]) => {
    const existing = groups.find((g) => g.name === name);
    if (existing) existing.picks.push(...picks);
    else groups.push({ name, picks });
  };
  for (const spec of list(input.values, 'group')) {
    const eq = spec.indexOf('=');
    const name = eq > 0 ? spec.slice(0, eq).trim() : '';
    if (eq <= 0 || eq === spec.length - 1)
      throw usage(
        '--group takes <name>=<layer>, with more layers joined by +, such as --group sewer=SEWER+VENT. A layer may name one colour: LAYER@#ff00ff.',
      );
    if (!GROUP_NAME.test(name))
      throw usage(
        'A group name is 1 to 60 characters, without = or control characters. Use a short name such as sewer.',
      );
    add(name, pickLayers(sheet, spec.slice(eq + 1)));
  }
  for (const spec of list(input.values, 'layer')) {
    const pick = pickLayer(sheet, spec);
    add(spec.trim(), [pick]);
  }
  if (!groups.length)
    throw usage(
      'Name what to measure: --layer <layer>, or --group <name>=<layer>+<layer>. Run `drawing-axi layers <file.pdf>` for the layer names.',
    );
  if (groups.length > 60) throw usage('At most 60 groups in one command.');
  return groups;
}

interface Settings {
  gapMm: number;
  minMm: number;
  area: Area;
  /** A gap for one group by name, from --group-gap. */
  groupGaps: Map<string, number>;
}

function settingsOf(input: CommandInput): Settings {
  return {
    gapMm: positiveNumber(input.values, 'gap', 8, 100),
    minMm: positiveNumber(input.values, 'min', 6, 1000),
    area: areaOf(input.values),
    groupGaps: groupGapsOf(input),
  };
}

/** `--group-gap NAME=MM`: a gap for one group. */
function groupGapsOf(input: CommandInput): Map<string, number> {
  const out = new Map<string, number>();
  for (const spec of list(input.values, 'group-gap')) {
    const eq = spec.lastIndexOf('=');
    const mm = Number(spec.slice(eq + 1));
    if (eq < 1 || !Number.isFinite(mm) || mm <= 0 || mm > 100)
      throw usage(
        '--group-gap takes <name>=<mm>, a gap above 0 and at most 100 mm.',
      );
    out.set(spec.slice(0, eq), mm);
  }
  return out;
}

/** What building runs left out or would have found at a wider gap. */
interface RunNotes {
  shadows: number;
  shadowPt: number;
  /** Groups whose runs grow by much at 1.5 times the gap. */
  wider: Array<{ group: number; gapMm: number; pt: number; widerPt: number }>;
}

type NamedRun = GroupedRun & { layer: string };

function runsOf(
  sheet: Sheet,
  groups: Group[],
  settings: Settings,
  notes?: RunNotes,
): NamedRun[] {
  for (const name of settings.groupGaps.keys())
    if (!groups.some((g) => g.name === name))
      throw usage(
        `--group-gap names no group called ${JSON.stringify(name)}; the groups are ${groups.map((g) => g.name).join(', ')}.`,
      );
  const out: NamedRun[] = [];
  const min = paperMm(settings.minMm);
  const letters = linetypeLetters(sheet);
  // Runs of one layer at a gap, with the runs that ride along others left out.
  const build = (segs: Float64Array, gapMm: number) => {
    const all = buildRuns(segs, {
      gap: paperMm(gapMm),
      letters,
      letterGap: paperMm(gapMm * LETTER_GAPS),
    }).filter((r) => r.length >= min);
    return dropShadows(all);
  };
  groups.forEach((group, index) => {
    const gapMm = settings.groupGaps.get(group.name) ?? settings.gapMm;
    let pt = 0;
    let widerPt = 0;
    for (const pick of group.picks) {
      const segs = segmentsOf(
        clipStrokes(strokesOf(sheet, pick), settings.area),
      );
      const { kept, dropped } = build(segs, gapMm);
      for (const run of kept) {
        out.push({ ...run, group: index, layer: pick.name });
        pt += run.length;
      }
      if (notes && dropped) {
        notes.shadows += dropped;
        const all = buildRuns(segs, {
          gap: paperMm(gapMm),
          letters,
          letterGap: paperMm(gapMm * LETTER_GAPS),
        }).filter((r) => r.length >= min);
        notes.shadowPt +=
          all.reduce((s, r) => s + r.length, 0) -
          kept.reduce((s, r) => s + r.length, 0);
      }
      if (notes && !settings.groupGaps.has(group.name))
        widerPt += build(segs, gapMm * WIDER).kept.reduce(
          (s, r) => s + r.length,
          0,
        );
    }
    // Dashes farther apart than the gap: the group's runs grow by a fifth
    // or more, and by a metre on paper's scale, at a gap half as wide again.
    if (
      notes &&
      !settings.groupGaps.has(group.name) &&
      widerPt >= pt * 1.2 &&
      widerPt - pt >= paperMm(10)
    )
      notes.wider.push({ group: index, gapMm: gapMm * WIDER, pt, widerPt });
  });
  return out;
}

/** The wider gap tried for the hint, as a share of the gap. */
const WIDER = 1.5;

/** Which part of the sheet was read, in words. */
function areaText(area: Area): string {
  if (wholeSheet(area)) return 'whole sheet';
  const boxes = `${area.exclude.length} excluded box${area.exclude.length === 1 ? '' : 'es'}`;
  if (!area.region) return `whole sheet outside ${boxes}`;
  return area.exclude.length
    ? `inside the region, outside ${boxes}`
    : 'inside the region only';
}

const settingsLine = (
  s: Settings,
  extra = '',
  notes?: RunNotes,
  m?: (pt: number) => number,
): string =>
  `pieces up to ${s.gapMm} mm apart on paper are joined, and up to ${s.gapMm * LETTER_GAPS} mm where a linetype letter sits in the break${[
    ...s.groupGaps,
  ]
    .map(([name, mm]) => `; group ${name} joins pieces up to ${mm} mm apart`)
    .join(
      '',
    )}; runs under ${s.minMm} mm on paper are left out${notes?.shadows && m ? `; ${notes.shadows} run${notes.shadows === 1 ? '' : 's'} that ride${notes.shadows === 1 ? 's' : ''} along another, ${round(m(notes.shadowPt), 1)} m, left out as linetype lettering` : ''}${extra}; ${areaText(s.area)}`;

const point = (x: number, y: number): string =>
  `${Math.round(x)},${Math.round(y)}`;

export function runs(input: CommandInput): string {
  const { sheet, name } = openSheet(input);
  const groups = groupsOf(input, sheet);
  const settings = settingsOf(input);
  const scale = scaleOf(input.values, sheet);
  const limit = positiveInt(input.values, 'limit', 20);
  const full = input.values.full === true;
  const notes: RunNotes = { shadows: 0, shadowPt: 0, wider: [] };
  const found = runsOf(sheet, groups, settings, notes).sort(
    (a, b) => b.length - a.length,
  );
  const rows: Row[] = found.map((r) => ({
    group: (groups[r.group] as Group).name,
    length_m: round(r.length / scale.ptPerM, 2),
    from: point(r.x0, r.y0),
    to: point(r.x1, r.y1),
    pieces: r.parts,
  }));
  const total = found.reduce((s, r) => s + r.length, 0) / scale.ptPerM;
  const saved = save(input.io, str(input.values, 'save'), {
    file: name,
    scale: { ratio: scale.ratio, pt_per_m: scale.ptPerM, basis: scale.basis },
    runs: rows,
  });
  const shown = full ? rows : rows.slice(0, limit);
  return listOutput({
    key: 'runs',
    summary: rows.length
      ? `${countLine(shown.length, rows.length, 'run')}, ${round(total, 1)} m in all, longest first`
      : '0 runs: the layers hold no straight line long enough',
    head: {
      file: name,
      scale: scaleLine(scale),
      settings: settingsLine(settings, '', notes, (pt) => pt / scale.ptPerM),
      saved,
    },
    rows: shown,
    columns: ['group', 'length_m', 'from', 'to', 'pieces'],
    full,
    narrower:
      'drawing-axi runs <file.pdf> --layer <layer> --region <x0,y0,x1,y1>',
    help: rows.length
      ? [
          'Run `drawing-axi measure <file.pdf> --group <name>=<layer> --group <name>=<layer>` for runs by pipe size, every system in one command',
          'Run `drawing-axi render <file.pdf> --layer <layer> --region <x0,y0,x1,y1> --out <file.png>` to see a run',
        ]
      : [
          'Run `drawing-axi layers <file.pdf>` for the layers that hold long runs',
        ],
  });
}

export function measure(input: CommandInput): string {
  const { sheet, name } = openSheet(input);
  const groups = groupsOf(input, sheet);
  const settings = settingsOf(input);
  const reachMm = positiveNumber(input.values, 'reach', 1.5, 50);
  const plain = input.values.plain === true;
  const scale = scaleOf(input.values, sheet);
  const limit = positiveInt(input.values, 'limit', 40);
  const full = input.values.full === true;
  const notes: RunNotes = { shadows: 0, shadowPt: 0, wider: [] };
  const found = runsOf(sheet, groups, settings, notes);
  const inside = sheet.labels.filter((l) =>
    inArea(settings.area, (l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2),
  );
  // With --plain, a size written alone counts too, unless a riser tag
  // claims it: that size is the riser's, not the pipe's beside it.
  const tagged = plain
    ? new Set(findTags(inside).map((t) => t.sizeLabel))
    : new Set<Label>();
  const labels = sizeLabels(inside.filter((l) => !tagged.has(l))).filter(
    (l) => l.onRun || (plain && l.alone),
  );
  // A group named by the code its labels carry (F, CW, HF) takes only those
  // labels, and gives them to no other group.
  const labelCodes = new Set(labels.map((l) => l.code));
  const codes = groups.map((g) => {
    const code = codeOf(g.name);
    return code !== null && labelCodes.has(code) ? code : null;
  });
  const boundCodes = codes.filter((c): c is string => c !== null);
  const placed = { count: 0, missed: [] as SizeLabel[] };
  const sized = sizeRuns(
    found,
    labels,
    { reach: paperMm(reachMm), codes },
    placed,
  );
  // Labels a reach twice as wide would place: an office may write its sizes
  // a few millimetres off the pipe.
  const wideReach = reachMm * 2;
  const reachable = { count: 0 };
  if (placed.missed.length)
    sizeRuns(found, labels, { reach: paperMm(wideReach), codes }, reachable);
  const more = reachable.count - placed.count;
  const picturesLine =
    sheet.pictureShare >= PICTURE_NOTE
      ? `pictures cover ${percent(sheet.pictureShare)} of the page; pipes drawn in them are not measured`
      : '';
  const labelsLine = `${placed.count} of ${labels.length} size labels in the area sit on a measured run${labels.length > placed.count ? '; the others belong to pipe that is not in these groups, or fit no run' : ''}${more > 0 ? `; ${more} more sit${more === 1 ? 's' : ''} within ${wideReach} mm of a run: try --reach ${wideReach} and check sized_by` : ''}`;
  const settingsText = settingsLine(
    settings,
    `; a size label counts within ${reachMm} mm of its run${plain ? ', plain sizes no tag claims included' : ''}${boundCodes.length ? `; labels coded ${boundCodes.join(', ')} go only to the groups of those names` : ''}`,
    notes,
    (pt) => pt / scale.ptPerM,
  );
  const m = (pt: number) => pt / scale.ptPerM;
  const gapsLine = notes.wider
    .map(({ group, gapMm, pt, widerPt }) => {
      const name = (groups[group] as Group).name;
      return `group ${name}: at ${gapMm} mm its pieces join into ${round(m(widerPt), 1)} m, not ${round(m(pt), 1)} m; its dashes may be farther apart than --gap. Check with \`drawing-axi runs\`, then pass --group-gap ${name}=${gapMm}`;
    })
    .join('. ');

  const groupRows: Row[] = groups.map((group, index) => {
    const mine = sized.filter((r) => r.group === index);
    const length = mine.reduce((s, r) => s + r.length, 0);
    const unsized = mine
      .filter((r) => !r.size)
      .reduce((s, r) => s + r.length, 0);
    return {
      group: group.name,
      length_m: round(m(length), 3),
      runs: mine.length,
      sized_m: round(m(length - unsized), 3),
      unsized_m: round(m(unsized), 3),
    };
  });
  const bySize = new Map<
    string,
    {
      group: number;
      size: string | null;
      length: number;
      labelled: number;
      runs: number;
    }
  >();
  for (const run of sized) {
    const key = `${run.group}|${run.size ?? ''}`;
    const e = bySize.get(key) ?? {
      group: run.group,
      size: run.size,
      length: 0,
      labelled: 0,
      runs: 0,
    };
    e.length += run.length;
    if (run.basis === 'label') e.labelled += run.length;
    e.runs++;
    bySize.set(key, e);
  }
  const sizeRows: Row[] = [...bySize.values()]
    .sort(
      (a, b) =>
        a.group - b.group ||
        Number(a.size === null) - Number(b.size === null) ||
        b.length - a.length,
    )
    .map((e) => ({
      group: (groups[e.group] as Group).name,
      size: e.size ?? 'unsized',
      length_m: round(m(e.length), 3),
      labelled_m: e.size === null ? null : round(m(e.labelled), 3),
      runs: e.runs,
    }));
  // Which label sized what, so a wrong pairing can be seen.
  const byLabel = new Map<
    string,
    { group: number; size: string; label: string; length: number; runs: number }
  >();
  for (const run of sized) {
    if (run.basis !== 'label' || !run.size || !run.label) continue;
    const key = `${run.group}|${run.size}|${run.label}`;
    const e = byLabel.get(key) ?? {
      group: run.group,
      size: run.size,
      label: run.label,
      length: 0,
      runs: 0,
    };
    e.length += run.length;
    e.runs++;
    byLabel.set(key, e);
  }
  const labelRows: Row[] = [...byLabel.values()]
    .sort((a, b) => a.group - b.group || b.length - a.length)
    .map((e) => ({
      group: (groups[e.group] as Group).name,
      size: e.size,
      label: e.label,
      labelled_m: round(m(e.length), 3),
      runs: e.runs,
    }));
  // Labels with a group's code that sit on no run: the sheet names a size
  // for the system there, and does not say which pipe.
  const apart = new Map<
    string,
    { group: number; size: string; label: string; labels: number }
  >();
  for (const label of placed.missed) {
    const group = label.code === null ? -1 : codes.indexOf(label.code);
    if (group < 0) continue;
    // One row for each way the label is written: CW1 and C.W.2 are two rows.
    const key = `${group}|${label.size}|${label.text}`;
    const e = apart.get(key);
    if (e) e.labels++;
    else
      apart.set(key, { group, size: label.size, label: label.text, labels: 1 });
  }
  const apartRows: Row[] = [...apart.values()]
    .sort((a, b) => a.group - b.group || b.labels - a.labels)
    .map((e) => ({
      group: (groups[e.group] as Group).name,
      size: e.size,
      label: e.label,
      labels: e.labels,
    }));
  const total = sized.reduce((s, r) => s + r.length, 0);
  // The saved copy keeps a thousandth of a metre; the screen rounds to a tenth.
  const screen = (rows: Row[]): Row[] =>
    rows.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [
          k,
          typeof v === 'number' && k.endsWith('_m') ? round(v, 1) : v,
        ]),
      ),
    );
  const saved = save(input.io, str(input.values, 'save'), {
    file: name,
    page: sheet.page,
    scale: {
      ratio: scale.ratio,
      pt_per_m: scale.ptPerM,
      basis: scale.basis,
      text: scaleLine(scale),
    },
    size_labels: labelsLine,
    ...(picturesLine ? { pictures: picturesLine } : {}),
    ...(gapsLine ? { gaps: gapsLine } : {}),
    settings_text: settingsText,
    settings: {
      gap_mm: settings.gapMm,
      min_mm: settings.minMm,
      reach_mm: reachMm,
      plain_size_labels: plain,
      region: settings.area.region,
      exclude: settings.area.exclude,
    },
    groups: groupRows.map((row, index) => ({
      ...row,
      layers: (groups[index] as Group).picks.map((p) => p.name),
    })),
    // Every size label that found no run, with its place, to look at.
    unplaced: placed.missed.map((l) => ({
      label: l.text,
      size: l.size,
      code: l.code,
      x: Math.round((l.x0 + l.x1) / 2),
      y: Math.round((l.y0 + l.y1) / 2),
    })),
    sizes: sizeRows,
    labels: labelRows,
    labels_apart: apartRows,
    runs: sized.map((r: SizedRun & { layer?: string }) => ({
      group: (groups[r.group] as Group).name,
      layer: r.layer,
      size: r.size,
      basis: r.basis,
      label: r.label,
      length_m: round(m(r.length), 3),
      from: [round(r.x0, 1), round(r.y0, 1)],
      to: [round(r.x1, 1), round(r.y1, 1)],
    })),
  });
  const anyUnsized = sized.some((r) => !r.size);
  const help = sized.length
    ? [
        ...(anyUnsized
          ? [
              'Run `drawing-axi tags <file.pdf>` and read the legend to size the unsized runs; never guess a size',
            ]
          : []),
        'Run `drawing-axi runs <file.pdf> --group <name>=<layer>` for each run and where it is',
        'Run `drawing-axi legend <file.pdf>` for the box to pass as --exclude, so legend samples are not measured',
      ]
    : [
        'Run `drawing-axi layers <file.pdf>` for the layers that hold long runs',
      ];
  const columns = ['group', 'size', 'length_m', 'labelled_m', 'runs'];
  return bounded(
    {
      total: full ? sizeRows.length : Math.min(sizeRows.length, limit),
      narrower:
        'drawing-axi measure <file.pdf> with fewer groups, or --save <file.json>',
      build: (shown, fieldLimit) => {
        const cap = full ? sizeRows.length : Math.min(sizeRows.length, limit);
        const dropped = sizeRows.length - Math.min(shown, cap);
        const doc: Row = {
          summary: `${plural(groups.length, 'group')}, ${round(m(total), 1)} m in ${plural(sized.length, 'run')}${dropped ? `; the last ${dropped} size rows left out to fit, use --limit or --save` : ''}`,
          file: name,
          scale: scaleLine(scale),
          settings: settingsText,
          size_labels: labelsLine,
          ...(picturesLine ? { pictures: picturesLine } : {}),
          ...(gapsLine ? { gaps: gapsLine } : {}),
          ...(saved ? { saved } : {}),
          groups: screen(groupRows).map((r) =>
            tableRow(
              r,
              ['group', 'length_m', 'runs', 'sized_m', 'unsized_m'],
              fieldLimit,
            ),
          ),
          sizes: screen(sizeRows)
            .slice(0, Math.min(shown, cap))
            .map((r) => tableRow(r, columns, fieldLimit)),
          // Which label sized what: a label of another system here is a
          // wrong pairing to check.
          ...(labelRows.length > 12
            ? {
                sized_by_shown: `the first 12 of ${labelRows.length}; --save writes all`,
              }
            : {}),
          ...(labelRows.length
            ? {
                sized_by: screen(labelRows)
                  .slice(0, 12)
                  .map((r) =>
                    tableRow(
                      r,
                      ['group', 'size', 'label', 'labelled_m', 'runs'],
                      fieldLimit,
                    ),
                  ),
              }
            : {}),
          // A size the sheet names for a system, away from any pipe: it is
          // for the owner to confirm, not a measured size.
          ...(apartRows.length > 12
            ? {
                labels_apart_shown: `the first 12 of ${apartRows.length}; --save writes all`,
              }
            : {}),
          ...(apartRows.length
            ? {
                labels_apart: apartRows
                  .slice(0, 12)
                  .map((r) =>
                    tableRow(
                      r,
                      ['group', 'size', 'label', 'labels'],
                      fieldLimit,
                    ),
                  ),
              }
            : {}),
        };
        return render(doc, help);
      },
    },
    full,
  );
}
