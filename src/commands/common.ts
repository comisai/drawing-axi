// What every command shares: opening a drawing, reading flags, naming layers,
// and turning the reader's failures into the closed set of errors.

import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { CommandInput, Io, Values } from '../cli/table.ts';
import {
  DeadlinePassed,
  DrawingTooLarge,
  readSheet,
} from '../drawing/extract.ts';
import {
  MM_PER_PT,
  parseColor,
  type Sheet,
  type Stroke,
} from '../drawing/model.ts';
import { type Scale, ScaleUnknown, sheetScale } from '../drawing/scale.ts';
import { AxiError, usage } from '../errors.ts';
import { EncryptedPdf, NotPdf, PdfDocument } from '../pdf/document.ts';
import { UnsupportedFilter } from '../pdf/filters.ts';
import { PdfSyntaxError } from '../pdf/objects.ts';

/** A drawing file may be at most this large. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

export const PAGE_FLAG = {
  type: 'string',
  value: '<n>',
  summary: 'Page to read, default 1',
} as const;
export const LIMIT_FLAG = {
  type: 'string',
  value: '<n>',
  summary: 'Rows to show, default 20',
} as const;
export const FULL_FLAG = {
  type: 'boolean',
  summary: 'Every row and field, without the size limit',
} as const;
export const SAVE_FLAG = {
  type: 'string',
  value: '<file.json>',
  summary: 'Also write every row, untruncated, to this JSON file',
} as const;
export const SCALE_FLAGS = {
  scale: {
    type: 'string',
    value: '<1:N>',
    summary: 'The scale, when the sheet states none or the wrong one',
  },
  'pt-per-m': {
    type: 'string',
    value: '<n>',
    summary: 'Points per metre you measured yourself; overrides --scale',
  },
} as const;
export const AREA_FLAGS = {
  region: {
    type: 'string',
    value: '<x0,y0,x1,y1>',
    summary: 'Only this box of the sheet, in points from the top-left corner',
  },
  exclude: {
    type: 'string',
    multiple: true,
    value: '<x0,y0,x1,y1>',
    summary: 'Leave this box out, such as the legend or the title block',
  },
} as const;

export function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
}

export function list(values: Values, name: string): string[] {
  const v = values[name];
  if (Array.isArray(v)) return v;
  return typeof v === 'string' ? [v] : [];
}

export function positiveInt(
  values: Values,
  name: string,
  fallback: number,
  max = 100_000,
): number {
  const raw = str(values, name);
  if (raw === undefined) return fallback;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) < 1 || Number(raw) > max)
    throw usage(`--${name} must be a whole number from 1 to ${max}.`);
  return Number(raw);
}

export function positiveNumber(
  values: Values,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = str(values, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !(n > 0) || n > max)
    throw usage(`--${name} must be a number above 0, at most ${max}.`);
  return n;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function parseBox(text: string, flag: string): Box {
  const parts = text.split(',').map((p) => p.trim());
  if (parts.length !== 4 || parts.some((p) => !/^-?\d+(\.\d+)?$/.test(p)))
    throw usage(
      `--${flag} takes four numbers, x0,y0,x1,y1, in points from the top-left corner.`,
    );
  const [a, b, c, d] = parts.map(Number) as [number, number, number, number];
  if (a === c || b === d) throw usage(`--${flag} must enclose some area.`);
  return {
    x0: Math.min(a, c),
    y0: Math.min(b, d),
    x1: Math.max(a, c),
    y1: Math.max(b, d),
  };
}

export interface Area {
  region: Box | null;
  exclude: Box[];
}

export function areaOf(values: Values): Area {
  const region = str(values, 'region');
  return {
    region: region === undefined ? null : parseBox(region, 'region'),
    exclude: list(values, 'exclude').map((e) => parseBox(e, 'exclude')),
  };
}

export const inBox = (box: Box, x: number, y: number): boolean =>
  x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;

/** Whether a point counts: inside the region, and in no excluded box. */
export function inArea(area: Area, x: number, y: number): boolean {
  if (area.region && !inBox(area.region, x, y)) return false;
  for (const box of area.exclude) if (inBox(box, x, y)) return false;
  return true;
}

export const wholeSheet = (area: Area): boolean =>
  !area.region && !area.exclude.length;

/** Cut strokes to the area: a segment counts when its middle is inside. */
export function clipStrokes(strokes: Stroke[], area: Area): Stroke[] {
  if (wholeSheet(area)) return strokes;
  const out: Stroke[] = [];
  for (const stroke of strokes) {
    const p = stroke.pts;
    let piece: number[] = [];
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i] as number;
      const y0 = p[i + 1] as number;
      const x1 = p[i + 2] as number;
      const y1 = p[i + 3] as number;
      if (inArea(area, (x0 + x1) / 2, (y0 + y1) / 2)) {
        if (!piece.length) piece.push(x0, y0);
        piece.push(x1, y1);
      } else if (piece.length) {
        out.push({ ...stroke, pts: piece });
        piece = [];
      }
    }
    if (piece.length) out.push({ ...stroke, pts: piece });
  }
  return out;
}

export interface Opened {
  path: string;
  name: string;
  bytes: number;
  doc: PdfDocument;
}

/** A path as the caller wrote it: relative to the working folder, `~` allowed. */
export function resolvePath(io: Io, file: string): string {
  const expanded =
    file === '~' || file.startsWith('~/') ? homedir() + file.slice(1) : file;
  return isAbsolute(expanded) ? expanded : resolve(io.cwd, expanded);
}

export function openPdf(io: Io, file: string): Opened {
  const path = resolvePath(io, file);
  const name = path.split(/[\\/]/).at(-1) ?? file;
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new AxiError(
        'not_found',
        'No file at that path. Check the path; run `drawing-axi` to list the PDF files in this folder.',
      );
    throw new AxiError(
      'not_found',
      `The file cannot be opened (${code ?? 'unknown error'}).`,
    );
  }
  let buf: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new AxiError('not_found', 'That path is not a file.');
    if (stat.size > MAX_FILE_BYTES)
      throw new AxiError(
        'too_large',
        `The file is ${stat.size} bytes; the limit is ${MAX_FILE_BYTES}.`,
        { bytes: stat.size, limit: MAX_FILE_BYTES },
      );
    buf = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buf, read, stat.size - read, read);
      if (!n) break;
      read += n;
    }
    buf = buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
  try {
    return { path, name, bytes: buf.length, doc: PdfDocument.open(buf) };
  } catch (error) {
    throw readerError(error);
  }
}

/** Turn a failure of the reader into one of the closed errors. */
export function readerError(error: unknown): unknown {
  if (error instanceof AxiError) return error;
  if (error instanceof NotPdf)
    return new AxiError(
      'not_pdf',
      'The file is not a PDF. drawing-axi reads drawings saved or plotted as PDF; ask for a PDF plot of a DWG, DXF or image.',
    );
  if (error instanceof EncryptedPdf)
    return new AxiError(
      'encrypted',
      'The PDF is encrypted. Remove the protection first, for example `qpdf --decrypt in.pdf out.pdf`, then read the copy.',
    );
  if (error instanceof UnsupportedFilter)
    return new AxiError(
      'unsupported',
      `The PDF uses a stream filter this tool does not read (${/^[A-Za-z0-9]{1,30}$/.test(error.filter) ? error.filter : 'unknown'}). Rewrite it first, for example \`qpdf --stream-data=uncompress in.pdf out.pdf\`.`,
    );
  if (error instanceof DrawingTooLarge)
    return new AxiError(
      'too_large',
      'The page holds more geometry than this tool reads at once. Split the drawing or read a simpler plot.',
    );
  if (error instanceof DeadlinePassed)
    return new AxiError(
      'timed_out',
      'The drawing took longer to read than this command is allowed. Run it again with more time, or in a worker.',
    );
  if (error instanceof PdfSyntaxError)
    return new AxiError(
      'damaged',
      'The PDF is damaged and could not be read. Repair it first, for example `qpdf in.pdf out.pdf`, then read the copy.',
    );
  return error;
}

/** Epoch milliseconds after which reading must stop, from COMIS_DEADLINE. */
export function deadlineOf(io: Io): number | undefined {
  const raw = io.env.COMIS_DEADLINE;
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d{10,16}$/.test(raw))
    throw usage(
      'COMIS_DEADLINE must be a time in epoch milliseconds, a positive whole number.',
    );
  // Leave time to print the answer.
  return Number(raw) - 500;
}

export interface OpenedSheet extends Opened {
  sheet: Sheet;
}

export function openSheet(input: CommandInput): OpenedSheet {
  const file = input.positionals[0];
  if (!file) throw usage('Missing <file.pdf>.');
  const opened = openPdf(input.io, file);
  const page = positiveInt(input.values, 'page', 1, 100_000);
  try {
    const pages = opened.doc.pages();
    if (!pages.length)
      throw new AxiError('damaged', 'The PDF has no pages that can be read.');
    if (page > pages.length)
      throw new AxiError(
        'no_page',
        `The PDF has ${pages.length} page${pages.length === 1 ? '' : 's'}; there is no page ${page}.`,
        { pages: pages.length },
      );
    const deadline = deadlineOf(input.io);
    const sheet = readSheet(opened.doc, page - 1, {
      ...(deadline === undefined ? {} : { deadline }),
      now: () => input.io.now().getTime(),
    });
    return { ...opened, sheet };
  } catch (error) {
    throw readerError(error);
  }
}

export function scaleOf(values: Values, sheet: Sheet): Scale {
  const scaleText = str(values, 'scale');
  let ratio: number | undefined;
  if (scaleText !== undefined) {
    const m = /^\s*(?:1\s*[:/]\s*)?(\d{1,5}(?:\.\d+)?)\s*$/.exec(scaleText);
    if (!m || !(Number(m[1]) > 0))
      throw usage('--scale takes a ratio such as 1:100.');
    ratio = Number(m[1]);
  }
  const ptPerM =
    str(values, 'pt-per-m') === undefined
      ? undefined
      : positiveNumber(values, 'pt-per-m', 1, 1_000_000);
  try {
    return sheetScale(sheet, {
      ...(ratio === undefined ? {} : { ratio }),
      ...(ptPerM === undefined ? {} : { ptPerM }),
    });
  } catch (error) {
    if (error instanceof ScaleUnknown)
      throw new AxiError(
        'scale_unknown',
        'The sheet states no scale. Read it from the title block and pass --scale 1:N, or measure a known length and pass --pt-per-m.',
      );
    throw error;
  }
}

/** Points on the sheet for a length in millimetres on paper. */
export const paperMm = (mm: number): number => mm / MM_PER_PT;

export const round = (value: number, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** "1300 x 900 mm". */
export const sheetSize = (sheet: Sheet): string =>
  `${Math.round(sheet.width * MM_PER_PT)} x ${Math.round(sheet.height * MM_PER_PT)} mm`;

export interface LayerPick {
  /** Index into sheet.layers. */
  layer: number;
  name: string;
  /** Only strokes of this colour, or null for every colour. */
  color: number | null;
}

/** Layer names that hold the text, for an unknown-layer message. */
function suggest(sheet: Sheet, wanted: string): string {
  const lower = wanted.toLowerCase();
  const close = sheet.layers
    .map((l) => l.name)
    .filter((n) => n.toLowerCase().includes(lower))
    .slice(0, 5);
  return close.length
    ? ` Layers that contain it: ${close.join(', ')}.`
    : ' Run `drawing-axi layers <file.pdf>` for the names.';
}

/** `NAME` or `NAME@#rrggbb`. The name is matched exactly, then without case. */
export function pickLayer(sheet: Sheet, spec: string): LayerPick {
  const at = spec.lastIndexOf('@');
  let name = spec;
  let color: number | null = null;
  if (at > 0) {
    const parsed = parseColor(spec.slice(at + 1));
    if (parsed !== null) {
      color = parsed;
      name = spec.slice(0, at);
    }
  }
  name = name.trim();
  if (!name) throw usage('A layer name is missing.');
  let index = sheet.layers.findIndex((l) => l.name === name);
  if (index < 0) {
    const matches = sheet.layers
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.name.toLowerCase() === name.toLowerCase());
    if (matches.length === 1) index = (matches[0] as { i: number }).i;
  }
  if (index < 0) {
    const shown = /^[\p{L}\p{N} _.|$+\-#()]{1,80}$/u.test(name)
      ? `\`${name}\``
      : 'that name';
    throw new AxiError(
      'unknown_layer',
      `The drawing has no layer named ${shown}.${suggest(sheet, name)}`,
    );
  }
  return {
    layer: index,
    name: (sheet.layers[index] as { name: string }).name,
    color,
  };
}

export function strokesOf(sheet: Sheet, pick: LayerPick): Stroke[] {
  return sheet.strokes.filter(
    (s) =>
      s.layer === pick.layer && (pick.color === null || s.color === pick.color),
  );
}

/** Write the complete result as JSON for a program to read. */
export function save(
  io: Io,
  file: string | undefined,
  data: unknown,
): string | null {
  if (file === undefined) return null;
  const path = resolvePath(io, file);
  try {
    writeFileSync(path, `${JSON.stringify(data, null, 1)}\n`);
  } catch (error) {
    throw new AxiError(
      'not_found',
      `The file given to --save cannot be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`,
    );
  }
  return path;
}

/** The path a caller would type: the bin's own name when it is on PATH. */
export function binPath(argv1: string | undefined): string {
  if (!argv1) return 'drawing-axi';
  const home = homedir();
  return argv1.startsWith(`${home}/`) ? `~${argv1.slice(home.length)}` : argv1;
}
