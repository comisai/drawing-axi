// `runs`: the straight runs on chosen layers. `measure`: their length by
// group and pipe size, the table a bill of quantities is built from.

import type { CommandInput } from '../cli/table.ts';
import type { Sheet } from '../drawing/model.ts';
import { buildRuns, segmentsOf } from '../drawing/runs.ts';
import {
  type GroupedRun,
  type SizedRun,
  sizeLabels,
  sizeRuns,
} from '../drawing/sizes.ts';
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
  list,
  openSheet,
  paperMm,
  pickLayer,
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
    add(
      name,
      spec
        .slice(eq + 1)
        .split('+')
        .map((part) => pickLayer(sheet, part)),
    );
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
}

function settingsOf(input: CommandInput): Settings {
  return {
    gapMm: positiveNumber(input.values, 'gap', 8, 100),
    minMm: positiveNumber(input.values, 'min', 6, 1000),
    area: areaOf(input.values),
  };
}

type NamedRun = GroupedRun & { layer: string };

function runsOf(sheet: Sheet, groups: Group[], settings: Settings): NamedRun[] {
  const out: NamedRun[] = [];
  const min = paperMm(settings.minMm);
  groups.forEach((group, index) => {
    for (const pick of group.picks) {
      const strokes = clipStrokes(strokesOf(sheet, pick), settings.area);
      for (const run of buildRuns(segmentsOf(strokes), {
        gap: paperMm(settings.gapMm),
      }))
        if (run.length >= min)
          out.push({ ...run, group: index, layer: pick.name });
    }
  });
  return out;
}

/** Which part of the sheet was read, in words. */
function areaText(area: Area): string {
  if (wholeSheet(area)) return 'whole sheet';
  const boxes = `${area.exclude.length} excluded box${area.exclude.length === 1 ? '' : 'es'}`;
  if (!area.region) return `whole sheet outside ${boxes}`;
  return area.exclude.length
    ? `inside the region, outside ${boxes}`
    : 'inside the region only';
}

const settingsLine = (s: Settings, extra = ''): string =>
  `pieces up to ${s.gapMm} mm apart on paper are joined; runs under ${s.minMm} mm on paper are left out${extra}; ${areaText(s.area)}`;

const point = (x: number, y: number): string =>
  `${Math.round(x)},${Math.round(y)}`;

export function runs(input: CommandInput): string {
  const { sheet, name } = openSheet(input);
  const groups = groupsOf(input, sheet);
  const settings = settingsOf(input);
  const scale = scaleOf(input.values, sheet);
  const limit = positiveInt(input.values, 'limit', 20);
  const full = input.values.full === true;
  const found = runsOf(sheet, groups, settings).sort(
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
      settings: settingsLine(settings),
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
          'Run `drawing-axi render <file.pdf> --layer <layer> --region <x0,y0,x1,y1> --out <file.svg>` to see a run',
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
  const found = runsOf(sheet, groups, settings);
  const labels = sizeLabels(
    sheet.labels.filter((l) =>
      inArea(settings.area, (l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2),
    ),
  ).filter((l) => plain || l.onRun);
  const placed = { count: 0 };
  const sized = sizeRuns(found, labels, { reach: paperMm(reachMm) }, placed);
  const labelsLine = `${placed.count} of ${labels.length} size labels in the area sit on a measured run${labels.length > placed.count ? '; the others belong to pipe that is not in these groups, or fit no run' : ''}`;
  const settingsText = settingsLine(
    settings,
    `; a size label counts within ${reachMm} mm of its run${plain ? ', plain sizes included' : ''}`,
  );
  const m = (pt: number) => pt / scale.ptPerM;

  const groupRows: Row[] = groups.map((group, index) => {
    const mine = sized.filter((r) => r.group === index);
    const length = mine.reduce((s, r) => s + r.length, 0);
    const unsized = mine
      .filter((r) => !r.size)
      .reduce((s, r) => s + r.length, 0);
    return {
      group: group.name,
      length_m: round(m(length), 1),
      runs: mine.length,
      sized_m: round(m(length - unsized), 1),
      unsized_m: round(m(unsized), 1),
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
      length_m: round(m(e.length), 1),
      labelled_m: e.size === null ? null : round(m(e.labelled), 1),
      runs: e.runs,
    }));
  const total = sized.reduce((s, r) => s + r.length, 0);
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
    settings_text: settingsText,
    settings: {
      gap_mm: settings.gapMm,
      min_mm: settings.minMm,
      reach_mm: reachMm,
      plain_size_labels: plain,
      region: settings.area.region,
      exclude: settings.area.exclude,
    },
    groups: groupRows,
    sizes: sizeRows,
    runs: sized.map((r: SizedRun & { layer?: string }) => ({
      group: (groups[r.group] as Group).name,
      layer: r.layer,
      size: r.size,
      basis: r.basis,
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
          ...(saved ? { saved } : {}),
          groups: groupRows.map((r) =>
            tableRow(
              r,
              ['group', 'length_m', 'runs', 'sized_m', 'unsized_m'],
              fieldLimit,
            ),
          ),
          sizes: sizeRows
            .slice(0, Math.min(shown, cap))
            .map((r) => tableRow(r, columns, fieldLimit)),
        };
        return render(doc, help);
      },
    },
    full,
  );
}
