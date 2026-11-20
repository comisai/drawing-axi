import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode } from '@toon-format/toon';
import { readSheet } from '../src/drawing/extract.ts';
import type { Sheet } from '../src/drawing/model.ts';
import { PdfDocument } from '../src/pdf/document.ts';
import type { PdfOptions } from './fixtures/pdf.ts';
import {
  oddDrawing,
  pictureDrawing,
  sampleDrawing,
  scanLike,
} from './fixtures/sample.ts';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'drawing-axi-test-'));
}

/** The binary under test: dist when DRAWING_AXI_BIN=dist, else the TypeScript source. */
export const BIN =
  process.env.DRAWING_AXI_BIN === 'dist'
    ? new URL('../dist/bin/drawing-axi.js', import.meta.url).pathname
    : new URL('../src/bin/drawing-axi.ts', import.meta.url).pathname;

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the binary as a separate process in `cwd`, with closed stdin. */
export function runBinary(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env } },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

/** A folder holding the sample drawing and its odd relatives. */
export function fixtureFolder(): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'plan.pdf'), sampleDrawing());
  writeFileSync(
    join(dir, 'plan-packed.pdf'),
    sampleDrawing({ xref: 'stream', compress: true }),
  );
  writeFileSync(join(dir, 'scan.pdf'), scanLike());
  writeFileSync(join(dir, 'odd.pdf'), oddDrawing());
  writeFileSync(join(dir, 'picture.pdf'), pictureDrawing());
  writeFileSync(join(dir, 'locked.pdf'), sampleDrawing({ encrypted: true }));
  writeFileSync(join(dir, 'notes.txt'), 'not a drawing\n');
  return dir;
}

export function sampleSheet(options: PdfOptions = {}, page = 0): Sheet {
  return readSheet(PdfDocument.open(sampleDrawing(options)), page);
}

/** The whole output, help footer included, as one TOON document. */
export function body(text: string): Record<string, unknown> {
  return decode(text) as Record<string, unknown>;
}

export function rowsOf(
  doc: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const rows = doc[key];
  if (!Array.isArray(rows)) throw new Error(`no ${key} in the output`);
  return rows as Array<Record<string, unknown>>;
}
