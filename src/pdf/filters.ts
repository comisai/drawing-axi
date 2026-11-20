// Stream filters: Flate, LZW, ASCIIHex, ASCII85 and RunLength, with the PNG
// and TIFF predictors. Image filters are never needed: image data is not read.

import { constants, inflateRawSync, inflateSync } from 'node:zlib';
import {
  type Dict,
  isDict,
  Name,
  type Obj,
  PdfSyntaxError,
} from './objects.ts';

/** No single stream may decode to more than this many bytes. */
export const MAX_STREAM_BYTES = 256 * 1024 * 1024;

export class UnsupportedFilter extends Error {
  readonly filter: string;
  constructor(filter: string) {
    super(`unsupported filter ${filter}`);
    this.name = 'UnsupportedFilter';
    this.filter = filter;
  }
}

function flate(data: Uint8Array): Uint8Array {
  const options = {
    maxOutputLength: MAX_STREAM_BYTES,
    // A stream cut short still yields what was written before the cut.
    finishFlush: constants.Z_SYNC_FLUSH,
  };
  try {
    return inflateSync(data, options);
  } catch (first) {
    if ((first as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
      throw new PdfSyntaxError('a stream decodes to more than 256 MB');
    try {
      // Some writers omit the zlib header.
      return inflateRawSync(data, options);
    } catch {
      throw new PdfSyntaxError('a Flate stream is damaged');
    }
  }
}

function lzw(data: Uint8Array, early: number): Uint8Array {
  const out: number[] = [];
  let table: number[][] = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < 256; i++) table.push([i]);
    table.push([], []);
  };
  reset();
  let bits = 9;
  let acc = 0;
  let have = 0;
  let previous: number[] | null = null;
  for (let i = 0; i < data.length; i++) {
    acc = (acc << 8) | (data[i] as number);
    have += 8;
    while (have >= bits) {
      const code = (acc >> (have - bits)) & ((1 << bits) - 1);
      have -= bits;
      acc &= (1 << have) - 1;
      if (code === 256) {
        reset();
        bits = 9;
        previous = null;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);
      let entry: number[];
      if (code < table.length) entry = table[code] as number[];
      else if (previous) entry = [...previous, previous[0] as number];
      else throw new PdfSyntaxError('an LZW stream is damaged');
      for (const b of entry) out.push(b);
      if (out.length > MAX_STREAM_BYTES)
        throw new PdfSyntaxError('a stream decodes to more than 256 MB');
      if (previous) table.push([...previous, entry[0] as number]);
      previous = entry;
      const size = table.length + early;
      if (size >= 2048) bits = 12;
      else if (size >= 1024) bits = 11;
      else if (size >= 512) bits = 10;
    }
  }
  return Uint8Array.from(out);
}

function asciiHex(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let high = -1;
  for (const c of data) {
    if (c === 62) break;
    const v =
      c >= 48 && c <= 57
        ? c - 48
        : c >= 65 && c <= 70
          ? c - 55
          : c >= 97 && c <= 102
            ? c - 87
            : -1;
    if (v < 0) continue;
    if (high < 0) high = v;
    else {
      out.push(high * 16 + v);
      high = -1;
    }
  }
  if (high >= 0) out.push(high * 16);
  return Uint8Array.from(out);
}

function ascii85(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  const flush = (n: number) => {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + (group[i] ?? 84);
    const bytes = [
      (v >>> 24) & 255,
      (v >>> 16) & 255,
      (v >>> 8) & 255,
      v & 255,
    ];
    for (let i = 0; i < n; i++) out.push(bytes[i] as number);
    group = [];
  };
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as number;
    if (c === 126) break;
    if (c === 122 && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117) continue;
    group.push(c - 33);
    if (group.length === 5) flush(4);
  }
  if (group.length > 1) flush(group.length - 1);
  return Uint8Array.from(out);
}

function runLength(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const n = data[i++] as number;
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++)
        out.push(data[i++] as number);
    } else {
      const b = data[i++] ?? 0;
      for (let k = 0; k < 257 - n; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

const int = (dict: Dict | null, key: string, fallback: number): number => {
  const v = dict?.get(key);
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
};

function predict(data: Uint8Array, parms: Dict | null): Uint8Array {
  const predictor = int(parms, 'Predictor', 1);
  if (predictor <= 1) return data;
  const colors = Math.max(1, int(parms, 'Colors', 1));
  const bpc = Math.max(1, int(parms, 'BitsPerComponent', 8));
  const columns = Math.max(1, int(parms, 'Columns', 1));
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return data;
    const out = Uint8Array.from(data);
    for (let row = 0; row + rowBytes <= out.length; row += rowBytes)
      for (let i = bpp; i < rowBytes; i++)
        out[row + i] =
          ((out[row + i] as number) + (out[row + i - bpp] as number)) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)] as number;
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[src + i] as number;
      const left = i >= bpp ? (out[dst + i - bpp] as number) : 0;
      const up = r > 0 ? (out[dst - rowBytes + i] as number) : 0;
      const upLeft =
        r > 0 && i >= bpp ? (out[dst - rowBytes + i - bpp] as number) : 0;
      let value = raw;
      if (type === 1) value = raw + left;
      else if (type === 2) value = raw + up;
      else if (type === 3) value = raw + ((left + up) >> 1);
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[dst + i] = value & 255;
    }
  }
  return out;
}

/** Decode stream bytes through the filters its dictionary names. */
export function decodeStream(
  data: Uint8Array,
  dict: Dict,
  resolve: (o: Obj) => Obj,
): Uint8Array {
  const filterObj = resolve(dict.get('Filter') ?? dict.get('F') ?? null);
  const filters = (Array.isArray(filterObj) ? filterObj : [filterObj])
    .map((f) => resolve(f))
    .filter((f): f is Name => f instanceof Name);
  if (!filters.length) return data;
  const parmsObj = resolve(dict.get('DecodeParms') ?? dict.get('DP') ?? null);
  const parmsList = Array.isArray(parmsObj) ? parmsObj : [parmsObj];
  let out = data;
  filters.forEach((filter, i) => {
    const p = resolve(parmsList[i] ?? null);
    const parms = isDict(p) ? p : null;
    switch (filter.name) {
      case 'FlateDecode':
      case 'Fl':
        out = predict(flate(out), parms);
        break;
      case 'LZWDecode':
      case 'LZW':
        out = predict(lzw(out, int(parms, 'EarlyChange', 1)), parms);
        break;
      case 'ASCIIHexDecode':
      case 'AHx':
        out = asciiHex(out);
        break;
      case 'ASCII85Decode':
      case 'A85':
        out = ascii85(out);
        break;
      case 'RunLengthDecode':
      case 'RL':
        out = runLength(out);
        break;
      default:
        throw new UnsupportedFilter(filter.name);
    }
  });
  return out;
}
