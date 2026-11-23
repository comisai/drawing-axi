// Just enough of PDF fonts to turn shown strings into text and to estimate
// how far they advance: ToUnicode maps, one- or two-byte codes, and widths.

import type { PdfDocument } from './document.ts';
import {
  type Dict,
  Keyword,
  Lexer,
  Name,
  PdfString,
  Stream,
} from './objects.ts';

export interface Font {
  /** Bytes per character code. */
  bytes: 1 | 2;
  toUnicode: Map<number, string> | null;
  fallback: (code: number) => string | null;
  /** Advance of a code in thousandths of the font size. */
  width: (code: number) => number;
}

const hex = (s: PdfString): number => {
  let v = 0;
  for (const b of s.bytes) v = v * 256 + b;
  return v;
};

const utf16 = (s: PdfString): string => {
  let out = '';
  for (let i = 0; i + 1 < s.bytes.length; i += 2)
    out += String.fromCharCode(
      ((s.bytes[i] as number) << 8) | (s.bytes[i + 1] as number),
    );
  return out;
};

/** Read the bfchar and bfrange sections of a ToUnicode CMap. */
export function parseToUnicode(data: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const lex = new Lexer(data);
  const pending: Array<PdfString | PdfString[]> = [];
  for (let guard = 0; guard < 2_000_000; guard++) {
    const token = lex.read();
    if (token === undefined) break;
    if (token instanceof PdfString) pending.push(token);
    else if (Array.isArray(token))
      pending.push(token.filter((t): t is PdfString => t instanceof PdfString));
    else if (token instanceof Keyword) {
      if (token.word === 'endbfchar') {
        for (let i = 0; i + 1 < pending.length; i += 2) {
          const src = pending[i];
          const dst = pending[i + 1];
          if (src instanceof PdfString && dst instanceof PdfString)
            map.set(hex(src), utf16(dst));
        }
      } else if (token.word === 'endbfrange') {
        for (let i = 0; i + 2 < pending.length; i += 3) {
          const lo = pending[i];
          const hi = pending[i + 1];
          const dst = pending[i + 2];
          if (!(lo instanceof PdfString) || !(hi instanceof PdfString))
            continue;
          const from = hex(lo);
          const to = Math.min(hex(hi), from + 65535);
          if (Array.isArray(dst)) {
            for (let c = from; c <= to; c++) {
              const d = dst[c - from];
              if (d) map.set(c, utf16(d));
            }
          } else if (dst instanceof PdfString) {
            const base = utf16(dst);
            const head = base.slice(0, -1);
            const last = base.charCodeAt(base.length - 1);
            for (let c = from; c <= to; c++)
              map.set(c, head + String.fromCharCode(last + (c - from)));
          }
        }
      }
      pending.length = 0;
    }
  }
  return map;
}

function byteValues(encoding: string): string[] {
  const decoder = new TextDecoder(encoding);
  return Array.from({ length: 256 }, (_, byte) =>
    decoder.decode(Uint8Array.of(byte)),
  );
}

const WIN_ANSI = byteValues('windows-1252');
const HEBREW = byteValues('windows-1255');
const MAC_ROMAN = byteValues('macintosh');
const UNREADABLE = /[\p{Cc}\p{Cs}\ufffd]/u;

function simpleEncoding(
  doc: PdfDocument,
  dict: Dict,
  hasUnicodeMap: boolean,
): Font['fallback'] {
  const encoding = doc.resolve(dict.get('Encoding') ?? null);
  const encodingDict = doc.dict(encoding);
  const base =
    encoding instanceof Name
      ? encoding
      : doc.resolve(encodingDict?.get('BaseEncoding') ?? null);
  const baseName = base instanceof Name ? base.name : undefined;
  const differences = doc.array(encodingDict?.get('Differences'));
  const glyphs = new Map<number, number | null>();
  let code = -1;
  for (const entry of differences) {
    if (typeof entry === 'number') {
      code = Number.isInteger(entry) && entry >= 0 && entry <= 255 ? entry : -1;
    } else if (entry instanceof Name && code >= 0 && code <= 255) {
      const decimal = /^MT(\d{1,3})$/.exec(entry.name);
      const byte = decimal ? Number(decimal[1]) : -1;
      glyphs.set(code++, byte >= 0 && byte <= 255 ? byte : null);
    }
  }
  // Some legacy Type 1 subsets name a glyph MT followed by its original
  // decimal byte. Several distinct high bytes in the Hebrew letter range,
  // with no other high bytes or explicit base, signal Windows-1255.
  const highBytes = new Set(
    [...glyphs.values()].filter((b): b is number => b !== null && b >= 0x80),
  );
  const numberedEncoding =
    baseName === undefined &&
    highBytes.size >= 3 &&
    [...highBytes].every((b) => b >= 0xe0 && b <= 0xfa)
      ? HEBREW
      : WIN_ANSI;
  const decoder =
    baseName === 'WinAnsiEncoding'
      ? WIN_ANSI
      : baseName === 'MacRomanEncoding'
        ? MAC_ROMAN
        : null;
  return (code) => {
    const glyph = glyphs.get(code);
    if (glyph === null) return null;
    if (glyph !== undefined) return numberedEncoding[glyph] ?? null;
    if (decoder) return decoder[code] ?? null;
    // Keep the byte interpretation of ordinary simple fonts with no map.
    // A broken map on an otherwise unknown encoding gives us no such basis.
    if (baseName === undefined && !hasUnicodeMap)
      return String.fromCharCode(code);
    if (baseName === 'StandardEncoding' && code < 0x7f)
      return String.fromCharCode(code);
    return null;
  };
}

export function readFont(doc: PdfDocument, dict: Dict): Font {
  const subtype = dict.get('Subtype');
  const composite = subtype instanceof Name && subtype.name === 'Type0';
  let toUnicode: Map<number, string> | null = null;
  const cmap = doc.resolve(dict.get('ToUnicode') ?? null);
  if (cmap instanceof Stream) {
    try {
      toUnicode = parseToUnicode(doc.streamBytes(cmap));
    } catch {
      toUnicode = null;
    }
  }
  if (composite) {
    const descendant = doc.dict(doc.array(dict.get('DescendantFonts'))[0]);
    const dw = doc.resolve(descendant?.get('DW') ?? null);
    const fallback = typeof dw === 'number' ? dw : 1000;
    const widths = new Map<number, number>();
    const w = doc.array(descendant?.get('W'));
    for (let i = 0; i < w.length; ) {
      const first = doc.resolve(w[i]);
      const second = doc.resolve(w[i + 1]);
      if (typeof first !== 'number') break;
      if (Array.isArray(second)) {
        second.forEach((v, k) => {
          const n = doc.resolve(v);
          if (typeof n === 'number') widths.set(first + k, n);
        });
        i += 2;
      } else {
        const third = doc.resolve(w[i + 2]);
        if (typeof second !== 'number' || typeof third !== 'number') break;
        for (let c = first; c <= Math.min(second, first + 65535); c++)
          widths.set(c, third);
        i += 3;
      }
    }
    return {
      bytes: 2,
      toUnicode,
      fallback: () => null,
      width: (code) => widths.get(code) ?? fallback,
    };
  }
  const firstChar = doc.resolve(dict.get('FirstChar') ?? null);
  const widths = doc.numbers(dict.get('Widths'));
  const first = typeof firstChar === 'number' ? firstChar : 0;
  return {
    bytes: 1,
    toUnicode,
    fallback: simpleEncoding(doc, dict, toUnicode !== null),
    width: (code) => widths[code - first] || 500,
  };
}

/** Decode a shown string, keeping its geometry even if a glyph is unreadable. */
export function fontText(
  font: Font,
  bytes: Uint8Array,
): {
  text: string;
  unreadable: boolean;
  advance: number;
  codes: number;
  spaces: number;
} {
  let text = '';
  let unreadable = bytes.length % font.bytes !== 0;
  let advance = 0;
  let codes = 0;
  let spaces = 0;
  for (let i = 0; i + font.bytes <= bytes.length; i += font.bytes) {
    const code =
      font.bytes === 2
        ? ((bytes[i] as number) << 8) | (bytes[i + 1] as number)
        : (bytes[i] as number);
    const mapped = font.toUnicode?.get(code);
    const decoded =
      mapped && !UNREADABLE.test(mapped) ? mapped : font.fallback(code);
    if (decoded && !UNREADABLE.test(decoded)) text += decoded;
    else unreadable = true;
    if (font.bytes === 1 && code === 32) spaces++;
    advance += font.width(code);
    codes++;
  }
  return { text, unreadable, advance, codes, spaces };
}
