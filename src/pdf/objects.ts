// The PDF object model, and the lexer that reads objects from bytes. The same
// lexer reads file-level objects and content streams; only file-level reading
// turns `12 0 R` into a reference.

export class Name {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class Ref {
  readonly num: number;
  readonly gen: number;
  constructor(num: number, gen: number) {
    this.num = num;
    this.gen = gen;
  }
}

export class PdfString {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
}

/** A keyword that is not a value: an operator in a content stream. */
export class Keyword {
  readonly word: string;
  constructor(word: string) {
    this.word = word;
  }
}

export type Dict = Map<string, Obj>;

export class Stream {
  readonly dict: Dict;
  /** Offset of the first data byte in the file, or -1 when `data` is set. */
  readonly offset: number;
  /** Raw (still encoded) bytes, for a stream held inside an object stream. */
  readonly data: Uint8Array | null;
  constructor(dict: Dict, offset: number, data: Uint8Array | null = null) {
    this.dict = dict;
    this.offset = offset;
    this.data = data;
  }
}

export type Obj =
  | null
  | boolean
  | number
  | Name
  | PdfString
  | Obj[]
  | Dict
  | Ref
  | Stream;

export class PdfSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfSyntaxError';
  }
}

export const isDict = (o: unknown): o is Dict => o instanceof Map;

// Character classes from the PDF specification, 7.2.2.
const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const REGULAR = new Uint8Array(256);
for (let c = 0; c < 256; c++) REGULAR[c] = WS[c] || DELIM[c] ? 0 : 1;

const hexValue = (c: number): number => {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
};

/** The deepest nesting of arrays and dictionaries the lexer follows. */
const MAX_DEPTH = 100;

export class Lexer {
  readonly buf: Uint8Array;
  pos: number;
  readonly end: number;

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  skipSpace(): void {
    const { buf, end } = this;
    let p = this.pos;
    while (p < end) {
      const c = buf[p] as number;
      if (WS[c]) p++;
      else if (c === 37) {
        while (p < end && buf[p] !== 10 && buf[p] !== 13) p++;
      } else break;
    }
    this.pos = p;
  }

  /** True when only white space and comments remain. */
  atEnd(): boolean {
    this.skipSpace();
    return this.pos >= this.end;
  }

  /**
   * The next object, a Keyword for anything that is not a value, or undefined
   * at the end. With `refs`, `12 0 R` is read as one reference.
   */
  read(refs = false, depth = 0): Obj | Keyword | undefined {
    this.skipSpace();
    const { buf, end } = this;
    if (this.pos >= end) return undefined;
    const c = buf[this.pos] as number;
    if (c === 47) return this.readName();
    if (c === 40) return this.readLiteral();
    if (c === 91) {
      if (depth > MAX_DEPTH) throw new PdfSyntaxError('nesting is too deep');
      this.pos++;
      const items: Obj[] = [];
      for (;;) {
        this.skipSpace();
        if (this.pos >= end) throw new PdfSyntaxError('unterminated array');
        if (buf[this.pos] === 93) {
          this.pos++;
          return items;
        }
        const item = this.read(refs, depth + 1);
        // A stray keyword inside an array is dropped, as readers do.
        if (item !== undefined && !(item instanceof Keyword)) items.push(item);
      }
    }
    if (c === 60) {
      if (buf[this.pos + 1] === 60) {
        if (depth > MAX_DEPTH) throw new PdfSyntaxError('nesting is too deep');
        this.pos += 2;
        const dict: Dict = new Map();
        for (;;) {
          this.skipSpace();
          if (this.pos >= end)
            throw new PdfSyntaxError('unterminated dictionary');
          if (buf[this.pos] === 62 && buf[this.pos + 1] === 62) {
            this.pos += 2;
            return dict;
          }
          const key = this.read(false, depth + 1);
          if (!(key instanceof Name)) {
            // Damaged dictionary: skip what is not a key.
            if (key === undefined)
              throw new PdfSyntaxError('unterminated dictionary');
            continue;
          }
          const value = this.read(refs, depth + 1);
          if (value === undefined)
            throw new PdfSyntaxError('unterminated dictionary');
          if (value instanceof Keyword) continue;
          dict.set(key.name, value);
        }
      }
      return this.readHex();
    }
    if (c === 62 || c === 93 || c === 41 || c === 123 || c === 125) {
      // A closing delimiter with nothing open: skip it.
      this.pos += c === 62 && buf[this.pos + 1] === 62 ? 2 : 1;
      return new Keyword(String.fromCharCode(c));
    }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const number = this.readNumber();
      if (number !== undefined) {
        if (refs && Number.isInteger(number) && number >= 0)
          return this.maybeRef(number);
        return number;
      }
    }
    const start = this.pos;
    let p = start;
    while (p < end && REGULAR[buf[p] as number]) p++;
    if (p === start) p++;
    this.pos = p;
    const word = latin1(buf, start, p);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Keyword(word);
  }

  /** After integer `num`: `gen R` makes a reference; otherwise rewind. */
  private maybeRef(num: number): number | Ref {
    const save = this.pos;
    this.skipSpace();
    const c = this.buf[this.pos] as number;
    if (c >= 48 && c <= 57) {
      const gen = this.readNumber();
      if (gen !== undefined && Number.isInteger(gen)) {
        this.skipSpace();
        if (
          this.buf[this.pos] === 82 &&
          !REGULAR[this.buf[this.pos + 1] ?? 32]
        ) {
          this.pos++;
          return new Ref(num, gen);
        }
      }
    }
    this.pos = save;
    return num;
  }

  private readNumber(): number | undefined {
    const { buf, end } = this;
    const start = this.pos;
    let p = start;
    let sign = 1;
    if (buf[p] === 45) {
      sign = -1;
      p++;
    } else if (buf[p] === 43) p++;
    // Some writers put a second minus sign; readers ignore it.
    while (buf[p] === 45) p++;
    let value = 0;
    let digits = 0;
    while (p < end) {
      const d = (buf[p] as number) - 48;
      if (d < 0 || d > 9) break;
      value = value * 10 + d;
      digits++;
      p++;
    }
    if (buf[p] === 46) {
      p++;
      let scale = 0.1;
      while (p < end) {
        const d = (buf[p] as number) - 48;
        if (d < 0 || d > 9) break;
        value += d * scale;
        scale /= 10;
        digits++;
        p++;
      }
    }
    if (!digits || (p < end && REGULAR[buf[p] as number])) return undefined;
    this.pos = p;
    return sign * value;
  }

  private readName(): Name {
    const { buf, end } = this;
    let p = this.pos + 1;
    const start = p;
    let plain = true;
    while (p < end && REGULAR[buf[p] as number]) {
      if (buf[p] === 35) plain = false;
      p++;
    }
    this.pos = p;
    if (plain) return new Name(latin1(buf, start, p));
    const bytes: number[] = [];
    for (let i = start; i < p; i++) {
      const c = buf[i] as number;
      const hi = c === 35 ? hexValue(buf[i + 1] ?? 0) : -1;
      const lo = c === 35 ? hexValue(buf[i + 2] ?? 0) : -1;
      if (hi >= 0 && lo >= 0 && i + 2 < p) {
        bytes.push(hi * 16 + lo);
        i += 2;
      } else bytes.push(c);
    }
    return new Name(Buffer.from(bytes).toString('utf8'));
  }

  private readLiteral(): PdfString {
    const { buf, end } = this;
    let p = this.pos + 1;
    const out: number[] = [];
    let depth = 1;
    while (p < end) {
      const c = buf[p] as number;
      if (c === 92) {
        const n = buf[p + 1] as number;
        p += 2;
        if (n === 110) out.push(10);
        else if (n === 114) out.push(13);
        else if (n === 116) out.push(9);
        else if (n === 98) out.push(8);
        else if (n === 102) out.push(12);
        else if (n === 13) {
          if (buf[p] === 10) p++;
        } else if (n === 10) {
          /* line continuation */
        } else if (n >= 48 && n <= 55) {
          let v = n - 48;
          for (let i = 0; i < 2; i++) {
            const d = (buf[p] as number) - 48;
            if (d < 0 || d > 7) break;
            v = v * 8 + d;
            p++;
          }
          out.push(v & 255);
        } else if (n !== undefined) out.push(n);
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41 && --depth === 0) {
        p++;
        break;
      }
      out.push(c);
      p++;
    }
    this.pos = p;
    return new PdfString(Uint8Array.from(out));
  }

  private readHex(): PdfString {
    const { buf, end } = this;
    let p = this.pos + 1;
    const out: number[] = [];
    let high = -1;
    while (p < end) {
      const c = buf[p++] as number;
      if (c === 62) break;
      const v = hexValue(c);
      if (v < 0) continue;
      if (high < 0) high = v;
      else {
        out.push(high * 16 + v);
        high = -1;
      }
    }
    if (high >= 0) out.push(high * 16);
    this.pos = p;
    return new PdfString(Uint8Array.from(out));
  }
}

export function latin1(buf: Uint8Array, start: number, end: number): string {
  return Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString(
    'latin1',
  );
}
