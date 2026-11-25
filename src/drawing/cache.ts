// A sheet, once read, is kept on disk by the file's content, so the next
// command on the same file does not read the PDF again. A large sheet takes
// seconds and hundreds of megabytes to read, and a takeoff runs some twenty
// commands on each sheet.
//
// An entry is named by a hash of the file's bytes, the page and this tool's
// version, so a changed file, another page or another version is another
// entry, and a stale one is never read. Entries live in a folder only the
// user can write to, are checked whole before use, and the oldest are
// dropped past a total size. Anything that goes wrong with the cache is
// treated as a miss: the command reads the PDF as before.

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { usage } from '../errors.ts';
import { VERSION } from '../version.ts';
import type {
  Box,
  Fill,
  Label,
  LabelSource,
  Layer,
  Sheet,
  Stroke,
} from './model.ts';

/** Raised when the layout of an entry changes. */
const FORMAT = 1;
const MAGIC = 0x53584144; // "DAXS" read little-endian.
const HEADER = 48;
/** All entries together stay under this many bytes by default. */
export const CACHE_BYTES = 1024 * 1024 * 1024;
/** And there are at most this many. */
export const CACHE_ENTRIES = 256;
/** A temporary file left by a command that was stopped is removed after this. */
const STALE_MS = 60 * 60 * 1000;
const ENTRY = /^[0-9a-f]{64}\.sheet$/;
const TEMPORARY = /^[0-9a-f]{64}\.sheet\.[0-9a-f]+\.tmp$/;

/**
 * The folder entries are kept in, or null when the cache is off.
 * DRAWING_AXI_CACHE names the folder, or turns the cache off with `off`;
 * otherwise it is `drawing-axi` in XDG_CACHE_HOME, or in ~/.cache.
 */
export function cacheFolder(env: NodeJS.ProcessEnv): string | null {
  const named = env.DRAWING_AXI_CACHE?.trim();
  if (named) {
    if (/^(off|0|false|no)$/i.test(named)) return null;
    if (!isAbsolute(named))
      throw usage(
        'DRAWING_AXI_CACHE must be `off` or the full path of a folder.',
      );
    return named;
  }
  const xdg = env.XDG_CACHE_HOME;
  if (xdg) return isAbsolute(xdg) ? join(xdg, 'drawing-axi') : null;
  const home = env.HOME;
  return home && isAbsolute(home) ? join(home, '.cache', 'drawing-axi') : null;
}

export interface CacheOptions {
  maxBytes?: number;
  maxEntries?: number;
}

export class SheetCache {
  readonly dir: string;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  private constructor(dir: string, maxBytes: number, maxEntries: number) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  /** The cache the environment asks for, or null when it is off or unsafe. */
  static open(
    env: NodeJS.ProcessEnv,
    options: CacheOptions = {},
  ): SheetCache | null {
    const dir = cacheFolder(env);
    return dir === null ? null : SheetCache.at(dir, options);
  }

  /**
   * A cache in this folder, made if missing. Null when the folder cannot be
   * made, is a link, belongs to someone else, or others may write to it: an
   * entry there could be swapped for another sheet.
   */
  static at(dir: string, options: CacheOptions = {}): SheetCache | null {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = lstatSync(dir);
      if (!stat.isDirectory()) return null;
      if (process.getuid && stat.uid !== process.getuid()) return null;
      if (process.platform !== 'win32' && stat.mode & 0o022) return null;
    } catch {
      return null;
    }
    return new SheetCache(
      dir,
      options.maxBytes ?? CACHE_BYTES,
      options.maxEntries ?? CACHE_ENTRIES,
    );
  }

  /** The entry's name: the file's bytes, the page, and what wrote it. */
  keyOf(data: Uint8Array, page: number): string {
    return createHash('sha256')
      .update(`drawing-axi ${VERSION} sheet ${FORMAT} page ${page}\n`)
      .update(data)
      .digest('hex');
  }

  /** The sheet kept under this key, or null. */
  get(key: string): Sheet | null {
    const path = join(this.dir, `${key}.sheet`);
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      return null;
    }
    let data: Uint8Array;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > this.maxBytes || stat.size < HEADER)
        return null;
      // A buffer of its own, so the numbers in it can be read in place.
      data = new Uint8Array(new ArrayBuffer(stat.size));
      let read = 0;
      while (read < stat.size) {
        const n = readSync(fd, data, read, stat.size - read, read);
        if (!n) return null;
        read += n;
      }
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
    if (keyIn(data) !== key) return null;
    const sheet = decodeSheet(data);
    if (sheet) {
      // Recently used: the last entries dropped.
      try {
        const now = new Date();
        utimesSync(path, now, now);
      } catch {}
    }
    return sheet;
  }

  /** Keep the sheet under this key. Never fails the command. */
  put(key: string, sheet: Sheet): void {
    try {
      const data = encodeSheet(sheet, key);
      if (data.length > this.maxBytes / 4) return;
      const path = join(this.dir, `${key}.sheet`);
      // Written whole under another name, then moved into place, so a
      // command running beside this one never reads half an entry.
      const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
      try {
        renameSync(temporary, path);
      } catch (error) {
        unlinkSync(temporary);
        throw error;
      }
      this.prune();
    } catch {}
  }

  /** Drop the least recently used entries past the size and the count. */
  private prune(): void {
    const kept: Array<{ path: string; bytes: number; used: number }> = [];
    const now = Date.now();
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name);
      try {
        if (ENTRY.test(name)) {
          const stat = statSync(path);
          kept.push({ path, bytes: stat.size, used: stat.mtimeMs });
        } else if (
          TEMPORARY.test(name) &&
          now - statSync(path).mtimeMs > STALE_MS
        )
          unlinkSync(path);
      } catch {}
    }
    kept.sort((a, b) => b.used - a.used);
    let bytes = 0;
    kept.forEach((entry, at) => {
      bytes += entry.bytes;
      if (bytes > this.maxBytes || at >= this.maxEntries)
        try {
          unlinkSync(entry.path);
        } catch {}
    });
  }
}

// An entry: a header, the text as JSON, then each number column as an
// array of its own, every part starting on a multiple of 8 bytes.
//
// header: magic u32, format u32, payload bytes u32, crc32 of the payload
// u32, key 32 bytes (zero when not kept under one).

const SOURCES: LabelSource[] = ['shx', 'text', 'note'];

interface Text {
  layers: Layer[];
  labels: Array<[string, string, LabelSource]>;
  skipped: string[];
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  private size = 0;

  private push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.size += bytes.length;
    const pad = (8 - (this.size % 8)) % 8;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.size += pad;
    }
  }

  u32(values: number[]): void {
    this.push(new Uint8Array(Uint32Array.from(values).buffer));
  }

  column(values: Float64Array | Int32Array | Uint32Array | Uint8Array): void {
    this.u32([values.length]);
    this.push(
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    );
  }

  text(value: unknown): void {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    this.u32([bytes.length]);
    this.push(bytes);
  }

  done(): Uint8Array {
    return Buffer.concat(this.parts, this.size);
  }
}

class Reader {
  private at = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  private take(bytes: number): number {
    const start = this.at;
    if (!(bytes >= 0) || start + bytes > this.data.length)
      throw new RangeError('the entry is cut short');
    this.at = start + bytes + ((8 - (bytes % 8)) % 8);
    return this.data.byteOffset + start;
  }

  u32(count: number): Uint32Array {
    const at = this.take(count * 4);
    return new Uint32Array(this.data.buffer, at, count);
  }

  count(): number {
    return this.u32(1)[0] as number;
  }

  /** The length of the next column, without moving past it. */
  peek(): number {
    const at = this.at;
    const n = this.count();
    this.at = at;
    return n;
  }

  f64(expected: number): Float64Array {
    const n = this.count();
    if (n !== expected) throw new RangeError('a column has the wrong length');
    return new Float64Array(this.data.buffer, this.take(n * 8), n);
  }

  i32(expected: number): Int32Array {
    const n = this.count();
    if (n !== expected) throw new RangeError('a column has the wrong length');
    return new Int32Array(this.data.buffer, this.take(n * 4), n);
  }

  ints(expected: number): Uint32Array {
    const n = this.count();
    if (n !== expected) throw new RangeError('a column has the wrong length');
    return new Uint32Array(this.data.buffer, this.take(n * 4), n);
  }

  bytes(expected: number): Uint8Array {
    const n = this.count();
    if (n !== expected) throw new RangeError('a column has the wrong length');
    return new Uint8Array(this.data.buffer, this.take(n), n);
  }

  text(): unknown {
    const n = this.count();
    const at = this.take(n);
    return JSON.parse(
      Buffer.from(this.data.buffer, at, n).toString('utf8'),
    ) as unknown;
  }
}

/** The sheet as an entry, kept under `key` (64 hex digits) when given. */
export function encodeSheet(sheet: Sheet, key?: string): Uint8Array {
  const w = new Writer();
  // Room for the header, filled in at the end.
  w.u32(new Array(HEADER / 4).fill(0));
  const text: Text = {
    layers: sheet.layers,
    labels: sheet.labels.map((l) => [l.text, l.raw, l.source]),
    skipped: sheet.skipped,
  };
  w.text(text);
  w.column(
    Float64Array.from([
      sheet.page,
      sheet.pages,
      sheet.width,
      sheet.height,
      sheet.unreadableText,
      sheet.images,
      sheet.pictureShare,
    ]),
  );
  const strokes = sheet.strokes;
  w.column(Int32Array.from(strokes, (s) => s.layer));
  w.column(Uint32Array.from(strokes, (s) => s.color));
  w.column(Float64Array.from(strokes, (s) => s.width));
  w.column(Uint8Array.from(strokes, (s) => (s.dashed ? 1 : 0)));
  w.column(Uint32Array.from(strokes, (s) => s.pts.length));
  let total = 0;
  for (const s of strokes) total += s.pts.length;
  const pts = new Float64Array(total);
  let at = 0;
  for (const s of strokes) {
    pts.set(s.pts, at);
    at += s.pts.length;
  }
  w.column(pts);
  const fills = sheet.fills;
  w.column(Int32Array.from(fills, (f) => f.layer));
  w.column(Uint32Array.from(fills, (f) => f.color));
  w.column(
    Float64Array.from(fills.flatMap((f) => [f.x0, f.y0, f.x1, f.y1, f.area])),
  );
  const labels = sheet.labels;
  w.column(Int32Array.from(labels, (l) => l.layer));
  w.column(Uint8Array.from(labels, (l) => (l.vertical ? 1 : 0)));
  w.column(Float64Array.from(labels.flatMap((l) => [l.x0, l.y0, l.x1, l.y1])));
  w.column(
    Float64Array.from(sheet.pictures.flatMap((p) => [p.x0, p.y0, p.x1, p.y1])),
  );
  const out = w.done();
  const payload = out.subarray(HEADER);
  const head = new DataView(out.buffer, out.byteOffset, HEADER);
  head.setUint32(0, MAGIC, true);
  head.setUint32(4, FORMAT, true);
  head.setUint32(8, payload.length, true);
  head.setUint32(12, crc32(payload), true);
  if (key) out.set(Buffer.from(key, 'hex').subarray(0, 32), 16);
  return out;
}

/** The key an entry was kept under, in hex. */
function keyIn(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset + 16, 32).toString('hex');
}

/** The sheet in an entry, or null when it is not a whole, valid entry. */
export function decodeSheet(data: Uint8Array): Sheet | null {
  try {
    if (data.length < HEADER) return null;
    const head = new DataView(data.buffer, data.byteOffset, HEADER);
    if (head.getUint32(0, true) !== MAGIC) return null;
    if (head.getUint32(4, true) !== FORMAT) return null;
    const size = head.getUint32(8, true);
    if (HEADER + size !== data.length) return null;
    let payload = data.subarray(HEADER);
    if (crc32(payload) !== head.getUint32(12, true)) return null;
    // Columns are read in place, which needs them on a multiple of 8.
    if (payload.byteOffset % 8) payload = Uint8Array.from(payload);
    return readPayload(new Reader(payload));
  } catch {
    return null;
  }
}

function readPayload(r: Reader): Sheet | null {
  const text = r.text() as Text;
  if (
    !Array.isArray(text?.layers) ||
    !Array.isArray(text.labels) ||
    !Array.isArray(text.skipped)
  )
    return null;
  const [page, pages, width, height, unreadableText, images, pictureShare] =
    Array.from(r.f64(7));
  const strokeCount = r.peek();
  const layer = r.i32(strokeCount);
  const color = r.ints(strokeCount);
  const strokeWidth = r.f64(strokeCount);
  const dashed = r.bytes(strokeCount);
  const lengths = r.ints(strokeCount);
  let total = 0;
  for (const n of lengths) total += n;
  const all = r.f64(total);
  const strokes: Stroke[] = new Array(strokeCount);
  let at = 0;
  for (let i = 0; i < strokeCount; i++) {
    const n = lengths[i] as number;
    // Made at its full length: an array grown by push keeps spare room.
    const pts: number[] = new Array(n);
    for (let k = 0; k < n; k++) pts[k] = all[at + k] as number;
    at += n;
    strokes[i] = {
      layer: layer[i] as number,
      color: color[i] as number,
      width: strokeWidth[i] as number,
      dashed: dashed[i] === 1,
      pts,
    };
  }
  const fillCount = r.peek();
  const fillLayer = r.i32(fillCount);
  const fillColor = r.ints(fillCount);
  const box = r.f64(fillCount * 5);
  const fills: Fill[] = new Array(fillCount);
  for (let i = 0; i < fillCount; i++)
    fills[i] = {
      layer: fillLayer[i] as number,
      color: fillColor[i] as number,
      x0: box[i * 5] as number,
      y0: box[i * 5 + 1] as number,
      x1: box[i * 5 + 2] as number,
      y1: box[i * 5 + 3] as number,
      area: box[i * 5 + 4] as number,
    };
  const labelCount = text.labels.length;
  const labelLayer = r.i32(labelCount);
  const vertical = r.bytes(labelCount);
  const where = r.f64(labelCount * 4);
  const labels: Label[] = new Array(labelCount);
  for (let i = 0; i < labelCount; i++) {
    const [said, raw, source] = text.labels[i] as [string, string, LabelSource];
    if (
      typeof said !== 'string' ||
      typeof raw !== 'string' ||
      !SOURCES.includes(source)
    )
      return null;
    labels[i] = {
      text: said,
      raw,
      source,
      layer: labelLayer[i] as number,
      x0: where[i * 4] as number,
      y0: where[i * 4 + 1] as number,
      x1: where[i * 4 + 2] as number,
      y1: where[i * 4 + 3] as number,
      vertical: vertical[i] === 1,
    };
  }
  const pictureCount = Math.floor(r.peek() / 4);
  const corners = r.f64(pictureCount * 4);
  const pictures: Box[] = [];
  for (let i = 0; i < pictureCount; i++)
    pictures.push({
      x0: corners[i * 4] as number,
      y0: corners[i * 4 + 1] as number,
      x1: corners[i * 4 + 2] as number,
      y1: corners[i * 4 + 3] as number,
    });
  return {
    page: page as number,
    pages: pages as number,
    width: width as number,
    height: height as number,
    layers: text.layers.map((l) => ({
      name: String(l.name),
      hidden: !!l.hidden,
    })),
    strokes,
    fills,
    labels,
    unreadableText: unreadableText as number,
    images: images as number,
    pictures,
    pictureShare: pictureShare as number,
    skipped: text.skipped.map(String),
  };
}
