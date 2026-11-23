// A small PDF writer for tests. It writes the shapes of file that drawings
// come in: a classic cross-reference table or a cross-reference stream with
// object streams, plain or Flate content, rotated pages, layers, comments.
// Everything it writes is made up here; no real drawing is involved.

import { deflateSync } from 'node:zlib';

export interface Comment {
  /** Stored text, as a CAD program would keep it. */
  text: string;
  /** Sheet coordinates: points from the top-left corner. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The comment's author; CAD stroke-font text names its font technology. */
  author?: string;
}

export interface PageSpec {
  /** Sheet size in points, as a viewer shows it. */
  width: number;
  height: number;
  /** Content in sheet coordinates; see `Content`. */
  content: Content;
  comments?: Comment[];
}

export interface PdfOptions {
  /** How objects are indexed. */
  xref?: 'table' | 'stream';
  /** Flate-compress content streams. */
  compress?: boolean;
  /** Page rotation the file declares; the sheet looks the same either way. */
  rotate?: 0 | 90 | 180 | 270;
  /** Lower-left corner of the media box. */
  origin?: [number, number];
  userUnit?: number;
  /** Point `startxref` at the wrong place, so the table must be rebuilt. */
  breakXref?: boolean;
  /** Declare the file encrypted. */
  encrypted?: boolean;
  /** Layers switched off in the default view. */
  hidden?: string[];
  /**
   * Leave the layer list out of the catalog, as a tool that joins sheets into
   * one file does: each page still names its layers in its own resources.
   */
  noCatalogLayers?: boolean;
  /** Entries after /Type /Font in the test font dictionary. */
  font?: string;
  /** A character map stream for the test font. */
  toUnicode?: string;
}

type Point = [number, number];

/** Drawing operations in sheet coordinates, turned into a content stream. */
export class Content {
  readonly ops: Array<
    | { kind: 'raw'; text: string }
    | { kind: 'path'; points: Point[]; paint: string }
    | { kind: 'layer'; name: string }
    | { kind: 'end' }
    | { kind: 'text'; text: string; x: number; y: number; size: number }
  > = [];
  readonly layers: string[] = [];

  /** Start content on a named layer; `end()` closes it. */
  layer(name: string): this {
    if (!this.layers.includes(name)) this.layers.push(name);
    this.ops.push({ kind: 'layer', name });
    return this;
  }

  end(): this {
    this.ops.push({ kind: 'end' });
    return this;
  }

  /** Stroke colour as 0xRRGGBB, and line width in points. */
  pen(color: number, width = 1): this {
    const c = [(color >> 16) & 255, (color >> 8) & 255, color & 255]
      .map((v) => (v / 255).toFixed(3))
      .join(' ');
    this.ops.push({ kind: 'raw', text: `${c} RG ${c} rg ${width} w` });
    return this;
  }

  line(x0: number, y0: number, x1: number, y1: number): this {
    this.ops.push({
      kind: 'path',
      points: [
        [x0, y0],
        [x1, y1],
      ],
      paint: 'S',
    });
    return this;
  }

  /** A line plotted as separate dashes, as CAD programs plot linetypes. */
  dashes(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    dash = 12,
    gap = 4,
  ): this {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const ux = (x1 - x0) / length;
    const uy = (y1 - y0) / length;
    let drawn = 0;
    for (let at = 0; at < length; at += dash + gap) {
      drawn = Math.min(length, at + dash);
      this.line(x0 + ux * at, y0 + uy * at, x0 + ux * drawn, y0 + uy * drawn);
    }
    // A CAD linetype is fitted so that the line ends on a dash, not in a gap.
    if (length - drawn > 0.001) {
      const at = Math.max(length - dash / 2, drawn - dash / 2);
      this.line(x0 + ux * at, y0 + uy * at, x1, y1);
    }
    return this;
  }

  polyline(points: Point[], paint: 'S' | 's' | 'f' | 'b' = 'S'): this {
    this.ops.push({ kind: 'path', points, paint });
    return this;
  }

  /** A closed square outline of the given side, centred on a point. */
  square(cx: number, cy: number, side: number): this {
    const h = side / 2;
    return this.polyline(
      [
        [cx - h, cy - h],
        [cx + h, cy - h],
        [cx + h, cy + h],
        [cx - h, cy + h],
      ],
      's',
    );
  }

  /** Text in a real font (Helvetica), left end on the baseline at x, y. */
  text(text: string, x: number, y: number, size = 8): this {
    this.ops.push({ kind: 'text', text, x, y, size });
    return this;
  }
}

const num = (v: number): string => {
  const s = v.toFixed(3);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

function utf16Hex(text: string): string {
  let out = 'FEFF';
  for (let i = 0; i < text.length; i++)
    out += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${out}>`;
}

const literal = (text: string): string =>
  `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** PNG "Up" predictor rows, as cross-reference streams usually store them. */
function predictUp(data: Uint8Array, columns: number): Uint8Array {
  const rows = data.length / columns;
  const out = new Uint8Array(rows * (columns + 1));
  for (let r = 0; r < rows; r++) {
    out[r * (columns + 1)] = 2;
    for (let c = 0; c < columns; c++) {
      const up = r ? (data[(r - 1) * columns + c] as number) : 0;
      out[r * (columns + 1) + 1 + c] =
        ((data[r * columns + c] as number) - up) & 255;
    }
  }
  return out;
}

export function buildPdf(pages: PageSpec[], options: PdfOptions = {}): Buffer {
  const rotate = options.rotate ?? 0;
  const [ox, oy] = options.origin ?? [0, 0];
  const unit = options.userUnit ?? 1;
  const layerNames: string[] = [];
  for (const page of pages)
    for (const name of page.content.layers)
      if (!layerNames.includes(name)) layerNames.push(name);

  // Object numbers: 1 catalog, 2 pages, 3 font, then layers, then per page
  // the page, its content and its comments.
  const objects = new Map<
    number,
    string | { dict: string; data: Uint8Array }
  >();
  let next = 4;
  const layerObj = new Map<string, number>();
  for (const name of layerNames) layerObj.set(name, next++);
  for (const [name, n] of layerObj)
    objects.set(n, `<< /Type /OCG /Name ${utf16Hex(name)} >>`);

  const pageRefs: number[] = [];
  for (const page of pages) {
    const w = page.width / unit;
    const h = page.height / unit;
    // Sheet coordinates to this file's user space, undoing the rotation.
    const toPdf = (x: number, y: number): Point => {
      const X = x / unit;
      const Y = y / unit;
      switch (rotate) {
        case 90:
          return [Y + ox, X + oy];
        case 180:
          return [ox + w - X, Y + oy];
        case 270:
          return [ox + h - Y, oy + w - X];
        default:
          return [X + ox, oy + h - Y];
      }
    };
    const box =
      rotate === 90 || rotate === 270
        ? [ox, oy, ox + h, oy + w]
        : [ox, oy, ox + w, oy + h];
    const lines: string[] = [];
    for (const op of page.content.ops) {
      if (op.kind === 'raw') lines.push(op.text);
      else if (op.kind === 'layer')
        lines.push(`/OC /L${layerNames.indexOf(op.name)} BDC`);
      else if (op.kind === 'end') lines.push('EMC');
      else if (op.kind === 'path') {
        const parts = op.points.map(([x, y], i) => {
          const [px, py] = toPdf(x, y);
          return `${num(px)} ${num(py)} ${i ? 'l' : 'm'}`;
        });
        lines.push(`${parts.join(' ')} ${op.paint}`);
      } else {
        const [px, py] = toPdf(op.x, op.y);
        // The text runs along the sheet's x axis whatever the rotation.
        const [qx, qy] = toPdf(op.x + 1, op.y);
        const a = (qx - px) * unit;
        const b = (qy - py) * unit;
        lines.push(
          `BT /F1 ${num(op.size / unit)} Tf ${num(a)} ${num(b)} ${num(-b)} ${num(a)} ${num(px)} ${num(py)} Tm ${literal(op.text)} Tj ET`,
        );
      }
    }
    const raw = Buffer.from(`${lines.join('\n')}\n`, 'latin1');
    const pageNum = next++;
    const contentNum = next++;
    const data = options.compress ? deflateSync(raw) : raw;
    objects.set(contentNum, {
      dict: `<< /Length ${data.length}${options.compress ? ' /Filter /FlateDecode' : ''} >>`,
      data,
    });
    const annots: number[] = [];
    for (const c of page.comments ?? []) {
      const [ax, ay] = toPdf(c.x0, c.y0);
      const [bx, by] = toPdf(c.x1, c.y1);
      const n = next++;
      annots.push(n);
      objects.set(
        n,
        `<< /Type /Annot /Subtype /Square /Rect [${num(Math.min(ax, bx))} ${num(Math.min(ay, by))} ${num(Math.max(ax, bx))} ${num(Math.max(ay, by))}] /T ${literal(c.author ?? 'AutoCAD SHX Text')} /F 4 /Contents ${utf16Hex(c.text)} /Border [0 0 0] >>`,
      );
    }
    const properties = layerNames
      .map((name, i) => `/L${i} ${layerObj.get(name)} 0 R`)
      .join(' ');
    objects.set(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [${box.map(num).join(' ')}]${rotate ? ` /Rotate ${rotate}` : ''}${unit !== 1 ? ` /UserUnit ${num(unit)}` : ''} /Resources << /Font << /F1 3 0 R >>${layerNames.length ? ` /Properties << ${properties} >>` : ''} >> /Contents ${contentNum} 0 R${annots.length ? ` /Annots [${annots.map((n) => `${n} 0 R`).join(' ')}]` : ''} >>`,
    );
    pageRefs.push(pageNum);
  }
  const ocgs = [...layerObj.values()].map((n) => `${n} 0 R`).join(' ');
  const off = (options.hidden ?? [])
    .map((name) => `${layerObj.get(name)} 0 R`)
    .join(' ');
  objects.set(
    1,
    `<< /Type /Catalog /Pages 2 0 R${layerNames.length && !options.noCatalogLayers ? ` /OCProperties << /OCGs [${ocgs}] /D << /Order [${ocgs}]${off ? ` /OFF [${off}]` : ''} >> >>` : ''} >>`,
  );
  objects.set(
    2,
    `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.map((n) => `${n} 0 R`).join(' ')}] >>`,
  );
  let toUnicode = '';
  if (options.toUnicode !== undefined) {
    const data = Buffer.from(options.toUnicode, 'ascii');
    toUnicode = ` /ToUnicode ${next} 0 R`;
    objects.set(next++, { dict: `<< /Length ${data.length} >>`, data });
  }
  const font =
    options.font ??
    '/Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding';
  objects.set(3, `<< /Type /Font ${font}${toUnicode} >>`);

  const size = next;
  const chunks: Buffer[] = [
    Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'),
  ];
  let length = (chunks[0] as Buffer).length;
  const offsets = new Map<number, number>();
  const write = (text: string | Uint8Array) => {
    const b =
      typeof text === 'string'
        ? Buffer.from(text, 'latin1')
        : Buffer.from(text);
    chunks.push(b);
    length += b.length;
  };
  const writeObject = (
    n: number,
    body: string | { dict: string; data: Uint8Array },
  ) => {
    offsets.set(n, length);
    if (typeof body === 'string') write(`${n} 0 obj\n${body}\nendobj\n`);
    else {
      write(`${n} 0 obj\n${body.dict}\nstream\n`);
      write(body.data);
      write('\nendstream\nendobj\n');
    }
  };
  const encrypt = options.encrypted
    ? ' /Encrypt << /Filter /Standard /V 1 /R 2 /O (owner) /U (user) /P -4 >>'
    : '';
  let xrefAt: number;
  if ((options.xref ?? 'table') === 'table') {
    for (const [n, body] of [...objects].sort((a, b) => a[0] - b[0]))
      writeObject(n, body);
    xrefAt = length;
    let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++)
      table += `${String(offsets.get(n) ?? 0).padStart(10, '0')} 00000 ${offsets.has(n) ? 'n' : 'f'} \n`;
    write(`${table}trailer\n<< /Size ${size} /Root 1 0 R${encrypt} >>\n`);
  } else {
    // Objects that are not streams go into one object stream.
    const packed = [...objects]
      .filter((e): e is [number, string] => typeof e[1] === 'string')
      .sort((a, b) => a[0] - b[0]);
    const streams = [...objects]
      .filter((e) => typeof e[1] !== 'string')
      .sort((a, b) => a[0] - b[0]);
    for (const [n, body] of streams) writeObject(n, body);
    const packNum = next++;
    let head = '';
    let body = '';
    for (const [n, text] of packed) {
      head += `${n} ${body.length} `;
      body += `${text}\n`;
    }
    const packData = deflateSync(Buffer.from(head + body, 'latin1'));
    writeObject(packNum, {
      dict: `<< /Type /ObjStm /N ${packed.length} /First ${head.length} /Length ${packData.length} /Filter /FlateDecode >>`,
      data: packData,
    });
    const xrefNum = next++;
    xrefAt = length;
    const total = next;
    const rows = new Uint8Array(total * 5);
    const set = (n: number, type: number, a: number, b: number) => {
      rows[n * 5] = type;
      rows[n * 5 + 1] = (a >>> 16) & 255;
      rows[n * 5 + 2] = (a >>> 8) & 255;
      rows[n * 5 + 3] = a & 255;
      rows[n * 5 + 4] = b;
    };
    set(0, 0, 0, 255);
    for (const [n, at] of offsets) set(n, 1, at, 0);
    packed.forEach(([n], index) => {
      set(n, 2, packNum, index);
    });
    set(xrefNum, 1, xrefAt, 0);
    const xrefData = deflateSync(predictUp(rows, 5));
    write(
      `${xrefNum} 0 obj\n<< /Type /XRef /Size ${total} /W [1 3 1] /Root 1 0 R${encrypt} /Length ${xrefData.length} /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 5 >> >>\nstream\n`,
    );
    write(xrefData);
    write('\nendstream\nendobj\n');
  }
  write(`startxref\n${options.breakXref ? 7 : xrefAt}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
