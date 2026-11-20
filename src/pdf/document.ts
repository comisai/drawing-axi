// A PDF file: its cross-reference data, lazily parsed objects, decoded
// streams and the page tree. Classic tables, cross-reference streams, object
// streams and incremental updates are read; a damaged table is rebuilt by
// scanning for objects. Encrypted files are refused.

import { decodeStream, MAX_STREAM_BYTES } from './filters.ts';
import {
  type Dict,
  isDict,
  Keyword,
  Lexer,
  latin1,
  Name,
  type Obj,
  PdfString,
  PdfSyntaxError,
  Ref,
  Stream,
} from './objects.ts';

type XrefEntry =
  | { kind: 'offset'; offset: number }
  | { kind: 'packed'; stream: number; index: number };

/** All decoded streams of one file together stay under this many bytes. */
const MAX_TOTAL_BYTES = 768 * 1024 * 1024;
const MAX_PAGES = 5000;

export class EncryptedPdf extends Error {
  constructor() {
    super('the file is encrypted');
    this.name = 'EncryptedPdf';
  }
}

export class NotPdf extends Error {
  constructor() {
    super('the file is not a PDF');
    this.name = 'NotPdf';
  }
}

export interface Page {
  dict: Dict;
  /** Lower-left x, lower-left y, upper-right x, upper-right y. */
  box: [number, number, number, number];
  rotate: 0 | 90 | 180 | 270;
  userUnit: number;
  resources: Dict;
}

export class PdfDocument {
  readonly buf: Uint8Array;
  private readonly xref = new Map<number, XrefEntry>();
  private readonly cache = new Map<number, Obj>();
  private readonly packed = new Map<number, Map<number, Obj>>();
  private readonly loading = new Set<number>();
  private decoded = 0;
  trailer: Dict = new Map();
  /** True when the cross-reference data was damaged and rebuilt by scanning. */
  rebuilt = false;
  version = '';

  private constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  static open(buf: Uint8Array): PdfDocument {
    const head = latin1(buf, 0, Math.min(buf.length, 1024));
    const at = head.indexOf('%PDF-');
    if (at < 0) throw new NotPdf();
    const doc = new PdfDocument(buf);
    doc.version = /^%PDF-(\d\.\d)/.exec(head.slice(at))?.[1] ?? '';
    try {
      doc.readXrefChain();
      if (doc.trailer.has('Encrypt')) throw new EncryptedPdf();
      if (!isDict(doc.resolve(doc.trailer.get('Root') ?? null)))
        throw new PdfSyntaxError('no catalog');
    } catch (error) {
      if (error instanceof EncryptedPdf) throw error;
      doc.rebuild();
    }
    if (doc.trailer.has('Encrypt')) throw new EncryptedPdf();
    return doc;
  }

  // ---- cross-reference data ------------------------------------------------

  private readXrefChain(): void {
    const tail = latin1(
      this.buf,
      Math.max(0, this.buf.length - 2048),
      this.buf.length,
    );
    const m = /startxref\s+(\d+)/g;
    let last: RegExpExecArray | null = null;
    for (let x = m.exec(tail); x; x = m.exec(tail)) last = x;
    if (!last) throw new PdfSyntaxError('no startxref');
    let offset: number | null = Number(last[1]);
    const seen = new Set<number>();
    let first = true;
    while (offset !== null && !seen.has(offset)) {
      seen.add(offset);
      const trailer = this.readXrefAt(offset);
      if (first) {
        this.trailer = trailer;
        first = false;
      }
      const hybrid = trailer.get('XRefStm');
      if (typeof hybrid === 'number' && !seen.has(hybrid)) {
        seen.add(hybrid);
        this.readXrefAt(hybrid);
      }
      const prev = trailer.get('Prev');
      offset = typeof prev === 'number' ? prev : null;
    }
    if (first) throw new PdfSyntaxError('no trailer');
  }

  /** Read one cross-reference section; entries already known are kept. */
  private readXrefAt(offset: number): Dict {
    if (!(offset >= 0 && offset < this.buf.length))
      throw new PdfSyntaxError('startxref points outside the file');
    const lex = new Lexer(this.buf, offset);
    lex.skipSpace();
    if (latin1(this.buf, lex.pos, lex.pos + 4) === 'xref') {
      lex.pos += 4;
      for (;;) {
        const save = lex.pos;
        const start = lex.read();
        if (start instanceof Keyword && start.word === 'trailer') break;
        const count = lex.read();
        if (typeof start !== 'number' || typeof count !== 'number') {
          lex.pos = save;
          throw new PdfSyntaxError('bad cross-reference table');
        }
        for (let i = 0; i < count; i++) {
          const at = lex.read();
          const gen = lex.read();
          const kind = lex.read();
          if (
            typeof at !== 'number' ||
            typeof gen !== 'number' ||
            !(kind instanceof Keyword)
          )
            throw new PdfSyntaxError('bad cross-reference entry');
          const num = start + i;
          if (kind.word === 'n' && at > 0 && !this.xref.has(num))
            this.xref.set(num, { kind: 'offset', offset: at });
        }
      }
      const trailer = lex.read(true);
      if (!isDict(trailer)) throw new PdfSyntaxError('bad trailer');
      return trailer;
    }
    const stream = this.parseIndirectAt(offset).value;
    if (!(stream instanceof Stream))
      throw new PdfSyntaxError('no cross-reference section');
    const dict = stream.dict;
    const w = dict.get('W');
    if (!Array.isArray(w) || w.length < 3)
      throw new PdfSyntaxError('bad cross-reference stream');
    const [w0, w1, w2] = w.map((n) => (typeof n === 'number' ? n : 0)) as [
      number,
      number,
      number,
    ];
    const size = dict.get('Size');
    const indexObj = dict.get('Index');
    const index = Array.isArray(indexObj)
      ? indexObj.map((n) => (typeof n === 'number' ? n : 0))
      : [0, typeof size === 'number' ? size : 0];
    const data = this.streamBytes(stream);
    const field = (at: number, width: number, fallback: number): number => {
      if (!width) return fallback;
      let v = 0;
      for (let i = 0; i < width; i++) v = v * 256 + (data[at + i] ?? 0);
      return v;
    };
    let p = 0;
    const row = w0 + w1 + w2;
    for (let k = 0; k + 1 < index.length; k += 2) {
      const start = index[k] as number;
      const count = index[k + 1] as number;
      for (let i = 0; i < count && p + row <= data.length; i++, p += row) {
        const type = field(p, w0, 1);
        const a = field(p + w0, w1, 0);
        const b = field(p + w0 + w1, w2, 0);
        const num = start + i;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { kind: 'offset', offset: a });
        else if (type === 2)
          this.xref.set(num, { kind: 'packed', stream: a, index: b });
      }
    }
    return dict;
  }

  /** Scan the whole file for `N G obj` and rebuild the table from that. */
  private rebuild(): void {
    this.rebuilt = true;
    this.xref.clear();
    this.cache.clear();
    this.packed.clear();
    const text = latin1(this.buf, 0, this.buf.length);
    const re = /(?:^|[\s>\]])(\d{1,10})[ \t]+(\d{1,5})[ \t]+obj\b/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const offset = m.index + m[0].indexOf(m[1] as string);
      // The last definition of an object number wins.
      this.xref.set(Number(m[1]), { kind: 'offset', offset });
    }
    if (!this.xref.size) throw new PdfSyntaxError('no objects found');
    let trailer: Dict | null = null;
    const tr = /trailer\s*<</g;
    for (let m = tr.exec(text); m; m = tr.exec(text)) {
      try {
        const d = new Lexer(this.buf, m.index + 7).read(true);
        if (isDict(d) && d.has('Root')) trailer = d;
      } catch {
        /* a damaged trailer: keep looking */
      }
    }
    let streamTrailer: Dict | null = null;
    let catalog: number | null = null;
    for (const [num] of [...this.xref]) {
      let value: Obj;
      try {
        value = this.resolve(new Ref(num, 0));
      } catch {
        this.xref.delete(num);
        continue;
      }
      if (value instanceof Stream) {
        const type = value.dict.get('Type');
        if (type instanceof Name && type.name === 'XRef') {
          // The last cross-reference stream describes the newest revision.
          if (value.dict.has('Root')) streamTrailer = value.dict;
        } else if (type instanceof Name && type.name === 'ObjStm') {
          try {
            for (const inner of this.loadPacked(num).keys())
              if (!this.xref.has(inner))
                this.xref.set(inner, {
                  kind: 'packed',
                  stream: num,
                  index: -1,
                });
          } catch {
            /* a damaged object stream holds nothing we can use */
          }
        }
      } else if (isDict(value)) {
        const type = value.get('Type');
        if (type instanceof Name && type.name === 'Catalog') catalog = num;
      }
    }
    trailer ??= streamTrailer;
    if (!trailer) {
      if (catalog === null) {
        for (const [num, entry] of this.xref) {
          if (entry.kind !== 'packed') continue;
          const value = this.resolve(new Ref(num, 0));
          const type = isDict(value) ? value.get('Type') : null;
          if (type instanceof Name && type.name === 'Catalog') catalog = num;
        }
      }
      if (catalog === null) throw new PdfSyntaxError('no catalog found');
      trailer = new Map<string, Obj>([['Root', new Ref(catalog, 0)]]);
    }
    this.trailer = trailer;
  }

  // ---- objects -------------------------------------------------------------

  private parseIndirectAt(offset: number): { num: number; value: Obj } {
    const lex = new Lexer(this.buf, offset);
    const num = lex.read();
    const gen = lex.read();
    const kw = lex.read();
    if (
      typeof num !== 'number' ||
      typeof gen !== 'number' ||
      !(kw instanceof Keyword) ||
      kw.word !== 'obj'
    )
      throw new PdfSyntaxError(`no object at offset ${offset}`);
    const value = lex.read(true);
    if (value === undefined || value instanceof Keyword)
      return { num, value: null };
    if (isDict(value)) {
      lex.skipSpace();
      if (latin1(this.buf, lex.pos, lex.pos + 6) === 'stream') {
        let p = lex.pos + 6;
        if (this.buf[p] === 13) p++;
        if (this.buf[p] === 10) p++;
        return { num, value: new Stream(value, p) };
      }
    }
    return { num, value };
  }

  /** Follow references until a direct object is reached. */
  resolve(o: Obj | undefined): Obj {
    let value: Obj = o ?? null;
    for (let hops = 0; value instanceof Ref; hops++) {
      if (hops > 32) return null;
      value = this.load(value.num);
    }
    return value;
  }

  private load(num: number): Obj {
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached;
    const entry = this.xref.get(num);
    if (!entry || this.loading.has(num)) return null;
    this.loading.add(num);
    try {
      let value: Obj;
      if (entry.kind === 'offset') {
        const parsed = this.parseIndirectAt(entry.offset);
        value = parsed.value;
      } else {
        value = this.loadPacked(entry.stream).get(num) ?? null;
      }
      this.cache.set(num, value);
      return value;
    } finally {
      this.loading.delete(num);
    }
  }

  private loadPacked(streamNum: number): Map<number, Obj> {
    const known = this.packed.get(streamNum);
    if (known) return known;
    const out = new Map<number, Obj>();
    this.packed.set(streamNum, out);
    const entry = this.xref.get(streamNum);
    if (entry?.kind !== 'offset') return out;
    const stream = this.parseIndirectAt(entry.offset).value;
    if (!(stream instanceof Stream)) return out;
    const n = stream.dict.get('N');
    const first = stream.dict.get('First');
    if (typeof n !== 'number' || typeof first !== 'number') return out;
    const data = this.streamBytes(stream);
    const head = new Lexer(data, 0, Math.min(first, data.length));
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const num = head.read();
      const at = head.read();
      if (typeof num !== 'number' || typeof at !== 'number') break;
      pairs.push([num, at]);
    }
    for (const [num, at] of pairs) {
      const value = new Lexer(data, first + at).read(true);
      out.set(
        num,
        value === undefined || value instanceof Keyword ? null : value,
      );
    }
    return out;
  }

  // ---- streams -------------------------------------------------------------

  /** The decoded bytes of a stream. */
  streamBytes(stream: Stream): Uint8Array {
    const raw = stream.data ?? this.rawStream(stream);
    const out = decodeStream(raw, stream.dict, (o) => this.resolve(o));
    this.decoded += out.length;
    if (out.length > MAX_STREAM_BYTES || this.decoded > MAX_TOTAL_BYTES)
      throw new PdfSyntaxError('the file decodes to too much data');
    return out;
  }

  private rawStream(stream: Stream): Uint8Array {
    const { buf } = this;
    const start = stream.offset;
    const declared = this.resolve(stream.dict.get('Length') ?? null);
    if (
      typeof declared === 'number' &&
      declared >= 0 &&
      start + declared <= buf.length
    ) {
      // Trust the length only when `endstream` follows it.
      const after = latin1(buf, start + declared, start + declared + 16);
      if (/^\s*endstream/.test(after))
        return buf.subarray(start, start + declared);
    }
    const marker = Buffer.from('endstream');
    const at = Buffer.from(buf.buffer, buf.byteOffset, buf.length).indexOf(
      marker,
      start,
    );
    if (at < 0) throw new PdfSyntaxError('a stream has no end');
    let end = at;
    if (buf[end - 1] === 10) end--;
    if (buf[end - 1] === 13) end--;
    return buf.subarray(start, Math.max(start, end));
  }

  // ---- pages ---------------------------------------------------------------

  get catalog(): Dict {
    const root = this.resolve(this.trailer.get('Root') ?? null);
    if (!isDict(root)) throw new PdfSyntaxError('no catalog');
    return root;
  }

  dict(o: Obj | undefined): Dict | null {
    const v = this.resolve(o);
    if (isDict(v)) return v;
    if (v instanceof Stream) return v.dict;
    return null;
  }

  array(o: Obj | undefined): Obj[] {
    const v = this.resolve(o);
    return Array.isArray(v) ? v : [];
  }

  numbers(o: Obj | undefined): number[] {
    return this.array(o).map((n) => {
      const v = this.resolve(n);
      return typeof v === 'number' ? v : 0;
    });
  }

  /** A text string: UTF-16 or UTF-8 with a byte order mark, else PDFDocEncoding. */
  text(o: Obj | undefined): string | null {
    const v = this.resolve(o);
    if (v instanceof PdfString) return decodeText(v.bytes);
    if (v instanceof Name) return v.name;
    return null;
  }

  private pageList: Page[] | null = null;

  pages(): Page[] {
    if (this.pageList) return this.pageList;
    const out: Page[] = [];
    const seen = new Set<Dict>();
    const walk = (
      node: Dict,
      inherited: {
        box?: number[];
        crop?: number[];
        rotate?: number;
        resources?: Dict;
      },
      depth: number,
    ): void => {
      if (seen.has(node) || depth > 64 || out.length >= MAX_PAGES) return;
      seen.add(node);
      const here = { ...inherited };
      const media = this.numbers(node.get('MediaBox'));
      if (media.length === 4) here.box = media;
      const crop = this.numbers(node.get('CropBox'));
      if (crop.length === 4) here.crop = crop;
      const rotate = this.resolve(node.get('Rotate') ?? null);
      if (typeof rotate === 'number') here.rotate = rotate;
      const resources = this.dict(node.get('Resources'));
      if (resources) here.resources = resources;
      const kids = this.resolve(node.get('Kids') ?? null);
      const type = node.get('Type');
      if (
        Array.isArray(kids) &&
        !(type instanceof Name && type.name === 'Page')
      ) {
        for (const kid of kids) {
          const k = this.dict(kid);
          if (k) walk(k, here, depth + 1);
        }
        return;
      }
      const media4 = here.box ?? [0, 0, 612, 792];
      // What a viewer shows is the crop box, kept inside the media box.
      const c = here.crop ?? media4;
      const lo = (a: number, b: number) => Math.min(a, b);
      const hi = (a: number, b: number) => Math.max(a, b);
      const mx0 = lo(media4[0] as number, media4[2] as number);
      const my0 = lo(media4[1] as number, media4[3] as number);
      const mx1 = hi(media4[0] as number, media4[2] as number);
      const my1 = hi(media4[1] as number, media4[3] as number);
      let box: [number, number, number, number] = [
        hi(mx0, lo(c[0] as number, c[2] as number)),
        hi(my0, lo(c[1] as number, c[3] as number)),
        lo(mx1, hi(c[0] as number, c[2] as number)),
        lo(my1, hi(c[1] as number, c[3] as number)),
      ];
      if (!(box[2] > box[0] && box[3] > box[1])) box = [mx0, my0, mx1, my1];
      const turns = (((Math.round((here.rotate ?? 0) / 90) % 4) + 4) % 4) * 90;
      const unit = this.resolve(node.get('UserUnit') ?? null);
      out.push({
        dict: node,
        box,
        rotate: turns as 0 | 90 | 180 | 270,
        userUnit: typeof unit === 'number' && unit > 0 ? unit : 1,
        resources: here.resources ?? new Map(),
      });
    };
    const root = this.dict(this.catalog.get('Pages'));
    if (root) walk(root, {}, 0);
    this.pageList = out;
    return out;
  }

  /** A page's content streams, decoded and joined. */
  pageContent(page: Page): Uint8Array {
    const contents = this.resolve(page.dict.get('Contents') ?? null);
    const parts: Uint8Array[] = [];
    const add = (o: Obj) => {
      const s = this.resolve(o);
      if (s instanceof Stream) {
        parts.push(this.streamBytes(s));
        parts.push(Uint8Array.of(10));
      }
    };
    if (Array.isArray(contents)) for (const c of contents) add(c);
    else add(contents);
    return parts.length === 2 ? (parts[0] as Uint8Array) : Buffer.concat(parts);
  }
}

// PDFDocEncoding differs from Latin-1 in these positions (PDF 32000, D.2).
const PDF_DOC: Record<number, number> = {
  24: 0x02d8,
  25: 0x02c7,
  26: 0x02c6,
  27: 0x02d9,
  28: 0x02dd,
  29: 0x02db,
  30: 0x02da,
  31: 0x02dc,
  128: 0x2022,
  129: 0x2020,
  130: 0x2021,
  131: 0x2026,
  132: 0x2014,
  133: 0x2013,
  134: 0x0192,
  135: 0x2044,
  136: 0x2039,
  137: 0x203a,
  138: 0x2212,
  139: 0x2030,
  140: 0x201e,
  141: 0x201c,
  142: 0x201d,
  143: 0x2018,
  144: 0x2019,
  145: 0x201a,
  146: 0x2122,
  147: 0xfb01,
  148: 0xfb02,
  149: 0x0141,
  150: 0x0152,
  151: 0x0160,
  152: 0x0178,
  153: 0x017d,
  154: 0x0131,
  155: 0x0142,
  156: 0x0153,
  157: 0x0161,
  158: 0x017e,
  160: 0x20ac,
};

export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode(
        ((bytes[i] as number) << 8) | (bytes[i + 1] as number),
      );
    return out;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode(
        ((bytes[i + 1] as number) << 8) | (bytes[i] as number),
      );
    return out;
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return Buffer.from(bytes.subarray(3)).toString('utf8');
  let out = '';
  for (const b of bytes) out += String.fromCharCode(PDF_DOC[b] ?? b);
  return out;
}
