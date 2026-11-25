// A sheet with no layers, drawn in greys only: two systems share one grey and
// differ only by line width and dash pattern. Splitting by line style tells
// them apart, and every command that takes a layer takes the same selector.

import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { GREY, greyDrawing } from '../fixtures/sample.ts';
import {
  body,
  fixtureFolder,
  type Ran,
  rowsOf,
  runBinary,
} from '../helpers.ts';

let dir: string;
const run = (...args: string[]): Promise<Ran> => runBinary(args, dir);
const ok = async (...args: string[]) => {
  const r = await run(...args);
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}`);
  assert.equal(r.stderr, '', args.join(' '));
  return body(r.stdout);
};
const near = (actual: unknown, expected: number, what: string) =>
  assert.ok(
    Math.abs(Number(actual) - expected) < 0.5,
    `${what}: ${actual}, expected ${expected}`,
  );

before(() => {
  dir = realpathSync(fixtureFolder());
  writeFileSync(join(dir, 'grey.pdf'), greyDrawing());
});

describe('a sheet in greys with no layers', () => {
  it('splits by colour into one grey that holds both systems', async () => {
    const doc = await ok('layers', 'grey.pdf', '--split');
    const rows = rowsOf(doc, 'layers').filter((r) => r.color === '#666666');
    assert.equal(rows.length, 1);
    near(rows[0]?.run_m, GREY.a.metres + GREY.b.metres, 'one grey');
  });

  it('splits by line style into one row for each system', async () => {
    const doc = await ok('layers', 'grey.pdf', '--split', '--by', 'style');
    assert.match(String(doc.summary), /layers and line styles with ink/);
    const rows = rowsOf(doc, 'layers');
    const a = rows.find((r) => r.layer === GREY.a.style);
    const b = rows.find((r) => r.layer === GREY.b.style);
    assert.ok(a && b, JSON.stringify(rows));
    near(a.run_m, GREY.a.metres, 'system A');
    near(b.run_m, GREY.b.metres, 'system B');
    assert.equal(a.strokes, GREY.a.runs);
    assert.equal(b.strokes, GREY.b.runs);
    // --by style alone splits too.
    const alone = await ok('layers', 'grey.pdf', '--by', 'style');
    assert.deepEqual(rowsOf(alone, 'layers'), rows);
  });

  it('measures each system by its line style', async () => {
    const doc = await ok(
      'measure',
      'grey.pdf',
      '--layer',
      GREY.a.style,
      '--layer',
      GREY.b.style,
    );
    const groups = rowsOf(doc, 'groups');
    near(groups[0]?.length_m, GREY.a.metres, 'system A');
    near(groups[1]?.length_m, GREY.b.metres, 'system B');
    assert.equal(groups[0]?.runs, GREY.a.runs);
    assert.equal(groups[1]?.runs, GREY.b.runs);
  });

  it('takes part of a style: a width alone, or dashed or solid alone', async () => {
    const doc = await ok(
      'measure',
      'grey.pdf',
      '--group',
      'a=(no layer)@#666666 w0.7',
      '--group',
      'b=(no layer)@#666666 dashed',
      '--group',
      'thin=(no layer) w0.35',
    );
    const groups = rowsOf(doc, 'groups');
    near(groups[0]?.length_m, GREY.a.metres, 'a width alone');
    near(groups[1]?.length_m, GREY.b.metres, 'dashed alone');
    near(groups[2]?.length_m, GREY.b.metres, 'a width without a colour');
    const solid = await ok(
      'measure',
      'grey.pdf',
      '--layer',
      '(no layer)@#666666 solid',
    );
    near(rowsOf(solid, 'groups')[0]?.length_m, GREY.a.metres, 'solid alone');
  });

  it('lists the runs of one style', async () => {
    const doc = await ok('runs', 'grey.pdf', '--layer', GREY.b.style);
    const rows = rowsOf(doc, 'runs');
    assert.equal(rows.length, GREY.b.runs);
    for (const r of rows) near(r.length_m, 50, 'a run of B');
  });

  it('counts symbols and draws a picture of one style', async () => {
    await ok('symbols', 'grey.pdf', '--layer', GREY.a.style);
    const doc = await ok(
      'render',
      'grey.pdf',
      '--layer',
      GREY.a.style,
      '--out',
      'a.svg',
    );
    assert.match(String(doc.shows), /^1 layer, 10 strokes,/);
    assert.match(readFileSync(join(dir, 'a.svg'), 'utf8'), /<svg /);
  });

  it('says the ink is all greys and points to the style split', async () => {
    const info = await ok('info', 'grey.pdf');
    assert.match(String(info.ink), /^all greys \(3 shades\)$/);
    const notes = (info.notes as string[]).join(' ');
    assert.match(notes, /all greys/);
    assert.match(notes, /layers <file\.pdf> --split --by style/);
    assert.doesNotMatch(notes, /Tell systems apart by colour/);
    const layers = await ok('layers', 'grey.pdf');
    assert.match(String(layers.ink), /all greys/);
    assert.match(String(layers.ink), /--split --by style/);
    // Once split by style, the note is not repeated.
    const split = await ok('layers', 'grey.pdf', '--split', '--by', 'style');
    assert.equal(split.ink, undefined);
  });

  it('says nothing about greys on a sheet in colour', async () => {
    const info = await ok('info', 'plan.pdf');
    assert.equal(info.ink, '7 colours, 2 of them greys');
    assert.equal(info.notes, undefined);
    const layers = await ok('layers', 'plan.pdf');
    assert.equal(layers.ink, undefined);
  });

  it('refuses a split it does not know', async () => {
    const r = await run('layers', 'grey.pdf', '--by', 'size');
    assert.equal(r.code, 2);
    assert.equal(body(r.stdout).code, 'usage');
  });
});
