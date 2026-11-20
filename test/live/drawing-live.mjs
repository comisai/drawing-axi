#!/usr/bin/env node
// The live test: run drawing-axi on real drawings and compare what it reads
// with what a person measured. Real drawings belong to their owners, so they
// are never in this repository: the run reads a private plan file that names
// them, and its reports are gitignored and hold numbers, not drawings.
//
//   node test/live/drawing-live.mjs --plan <plan.json> [--strict] [--source]
//
// The plan file (see test/live/plan.example.json):
//   { "tolerance": 0.1,
//     "sheets": [ { "file": "/abs/path/plan.pdf", "exclude": ["x0,y0,x1,y1"],
//                   "groups": { "sewer": "SEWER+VENT" },
//                   "reference": { "sewer": 298.7 },
//                   "sizes": { "sewer": { "Ø160": 161.9 } },
//                   "legend_rows": 12, "labels_include": ["text"] } ] }
//
// Stages, per sheet:
//   L1 opens: info succeeds, in time, with layers and labels
//   L2 scale: a scale is found
//   L3 legend: at least the expected number of rows pair with a layer
//   L4 labels: the expected texts are read
//   L5 lengths: each group is within tolerance of the reference
//   L6 sizes: no size is given to more pipe than the reference has; how much
//      of the reference was sized is reported, not judged
//   L7 output: every default output is one TOON document within the bound
//   L8 repeat: the same command twice prints the same bytes
//   L9 picture: render writes well-formed SVG
// With --strict a blocked stage (no reference given) fails the run.

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '@toon-format/toon';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const strict = flag('strict');
const bin = flag('source')
  ? resolve(here, '../../src/bin/drawing-axi.ts')
  : resolve(here, '../../dist/bin/drawing-axi.js');
const planPath = value('plan') ?? process.env.DRAWING_LIVE_PLAN;
const OUTPUT_LIMIT = 4000;
const TIME_LIMIT_MS = 15_000;

if (!planPath) {
  process.stdout.write(
    `${encode({
      message:
        'Name the plan file: --plan <plan.json>, or set DRAWING_LIVE_PLAN. Copy test/live/plan.example.json and point it at your drawings.',
      code: 'usage',
    })}\n`,
  );
  process.exit(2);
}
const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8'));
const tolerance = plan.tolerance ?? 0.1;
// A size may fall short of the reference, since unlabelled pipe stays
// unsized; it must not exceed it by more than this.
const sizeTolerance = plan.size_tolerance ?? tolerance;
const work = mkdtempSync(join(tmpdir(), 'drawing-live-'));

function run(argv) {
  const started = Date.now();
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [bin, ...argv],
      { cwd: work, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        done({
          code: error ? Number(error.code ?? 1) : 0,
          stdout,
          stderr,
          ms: Date.now() - started,
        }),
    );
    child.stdin?.end();
  });
}

const parse = (text) => {
  try {
    return decode(text);
  } catch {
    return null;
  }
};
const within = (got, want) =>
  want === 0 ? Math.abs(got) < 0.5 : Math.abs(got / want - 1) <= tolerance;
const pct = (got, want) =>
  want
    ? `${got >= want ? '+' : ''}${(((got - want) / want) * 100).toFixed(1)}%`
    : 'n/a';

const results = [];
const record = (sheet, stage, status, detail) =>
  results.push({ sheet, stage, status, detail });

for (const [index, sheet] of plan.sheets.entries()) {
  // Reports name sheets by position, never by file name.
  const name = `sheet ${index + 1}`;
  const file = resolve(dirname(resolve(planPath)), sheet.file);
  const area = (sheet.exclude ?? []).flatMap((box) => ['--exclude', box]);
  const outputs = [];
  const call = async (argv) => {
    const r = await run(argv);
    outputs.push(r);
    return { ...r, doc: parse(r.stdout) };
  };

  const info = await call(['info', file]);
  if (info.code !== 0 || !info.doc) {
    record(
      name,
      'L1 opens',
      'fail',
      `info exited ${info.code}: ${info.doc?.code ?? 'no TOON'}`,
    );
    continue;
  }
  record(
    name,
    'L1 opens',
    info.ms <= TIME_LIMIT_MS ? 'pass' : 'fail',
    `${info.ms} ms; layers ${info.doc.layers}; ${info.doc.labels}`,
  );

  const scale = await call(['scale', file]);
  record(
    name,
    'L2 scale',
    scale.code === 0 ? 'pass' : 'fail',
    scale.code === 0
      ? `${scale.doc.scale}, ${scale.doc.pt_per_m} pt per m, ${scale.doc.basis}`
      : String(scale.doc?.code),
  );

  const legend = await call(['legend', file, '--limit', '200']);
  const legendRows = legend.doc?.legend?.length ?? 0;
  if (sheet.legend_rows === undefined)
    record(
      name,
      'L3 legend',
      'blocked',
      `${legendRows} rows; no expectation given`,
    );
  else
    record(
      name,
      'L3 legend',
      legendRows >= sheet.legend_rows ? 'pass' : 'fail',
      `${legendRows} rows, expected at least ${sheet.legend_rows}`,
    );

  if (!sheet.labels_include?.length)
    record(name, 'L4 labels', 'blocked', 'no expectation given');
  else {
    const missing = [];
    for (const text of sheet.labels_include) {
      const found = await call([
        'labels',
        file,
        '--match',
        text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ]);
      if (!(found.doc?.labels?.length > 0)) missing.push(text);
    }
    record(
      name,
      'L4 labels',
      missing.length ? 'fail' : 'pass',
      missing.length
        ? `${missing.length} of ${sheet.labels_include.length} expected texts not read`
        : `${sheet.labels_include.length} expected texts read`,
    );
  }

  const groups = Object.entries(sheet.groups ?? {});
  let measured = null;
  if (groups.length) {
    const argv = [
      'measure',
      file,
      ...groups.flatMap(([group, layers]) => ['--group', `${group}=${layers}`]),
      ...area,
      '--limit',
      '500',
    ];
    measured = await call(argv);
    const again = await run(argv);
    record(
      name,
      'L8 repeat',
      again.stdout === measured.stdout ? 'pass' : 'fail',
      again.stdout === measured.stdout
        ? 'identical bytes'
        : 'the second run differs',
    );
  } else record(name, 'L8 repeat', 'blocked', 'no groups given');

  const reference = Object.entries(sheet.reference ?? {});
  if (measured?.code !== 0 || !reference.length)
    record(
      name,
      'L5 lengths',
      measured && measured.code !== 0 ? 'fail' : 'blocked',
      measured && measured.code !== 0
        ? `measure failed: ${measured.doc?.code}`
        : 'no reference given',
    );
  else {
    const rows = [];
    let bad = 0;
    for (const [group, want] of reference) {
      const got = measured.doc.groups?.find((g) => g.group === group)?.length_m;
      const ok = typeof got === 'number' && within(got, want);
      if (!ok) bad++;
      rows.push(
        `${group} ${got ?? 'missing'} vs ${want} (${typeof got === 'number' ? pct(got, want) : 'n/a'})`,
      );
    }
    record(name, 'L5 lengths', bad ? 'fail' : 'pass', rows.join('; '));
  }

  const sizes = Object.entries(sheet.sizes ?? {});
  if (measured?.code !== 0 || !sizes.length)
    record(name, 'L6 sizes', 'blocked', 'no size reference given');
  else {
    const rows = [];
    let bad = 0;
    for (const [group, bySize] of sizes) {
      for (const [size, want] of Object.entries(bySize)) {
        const got =
          measured.doc.sizes?.find((s) => s.group === group && s.size === size)
            ?.length_m ?? 0;
        if (got > want * (1 + sizeTolerance)) bad++;
        rows.push(
          `${group} ${size} ${got} of ${want} (${want ? Math.round((got / want) * 100) : 0}% sized)`,
        );
      }
    }
    record(name, 'L6 sizes', bad ? 'fail' : 'pass', rows.join('; '));
  }

  const picture = join(work, `sheet-${index + 1}.svg`);
  const render = await call([
    'render',
    file,
    '--out',
    picture,
    '--force',
    '--width',
    '1200',
  ]);
  let svgOk = false;
  if (render.code === 0) {
    const svg = readFileSync(picture, 'utf8');
    svgOk = svg.startsWith('<svg ') && svg.trimEnd().endsWith('</svg>');
  }
  record(
    name,
    'L9 picture',
    svgOk ? 'pass' : render.doc?.code === 'too_large' ? 'blocked' : 'fail',
    svgOk ? String(render.doc.picture) : String(render.doc?.code),
  );

  await call(['layers', file]);
  await call(['labels', file]);
  await call(['tags', file]);
  const loud = outputs.filter(
    (o) =>
      o.stderr !== '' ||
      o.stdout.length > OUTPUT_LIMIT + 2000 ||
      !parse(o.stdout),
  );
  const over = outputs.filter((o) => o.stdout.length > OUTPUT_LIMIT).length;
  record(
    name,
    'L7 output',
    loud.length ? 'fail' : 'pass',
    `${outputs.length} outputs; ${over} over ${OUTPUT_LIMIT} characters by request (--limit); slowest ${Math.max(...outputs.map((o) => o.ms))} ms`,
  );
}

const count = (status) => results.filter((r) => r.status === status).length;
const failed = count('fail') + (strict ? count('blocked') : 0);
const reports = join(here, 'reports');
mkdirSync(reports, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(reports, `${stamp}.json`);
writeFileSync(
  reportPath,
  `${JSON.stringify({ at: new Date().toISOString(), bin: basename(bin), strict, tolerance, sheets: plan.sheets.length, results }, null, 1)}\n`,
  { mode: 0o600 },
);
process.stdout.write(
  `${encode({
    summary: `${plan.sheets.length} sheets: ${count('pass')} pass, ${count('fail')} fail, ${count('blocked')} blocked${strict ? ' (strict: blocked fails)' : ''}`,
    tolerance: `${tolerance * 100}%`,
    report: reportPath,
    results: results.map((r) => ({
      sheet: r.sheet,
      stage: r.stage,
      status: r.status,
      detail: r.detail.length > 300 ? `${r.detail.slice(0, 300)} …` : r.detail,
    })),
  })}\n`,
);
process.exit(failed ? 1 : 0);
