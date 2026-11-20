// Read one page into a Sheet: walk the content stream, keep every stroked and
// filled path with the layer it was drawn on, and collect the labels (text in
// real fonts, and the comments CAD programs keep for stroke-font text).

import type { Page, PdfDocument } from '../pdf/document.ts';
import { type Font, fontText, readFont } from '../pdf/fonts.ts';
import {
  type Dict,
  Keyword,
  Lexer,
  Name,
  type Obj,
  PdfString,
  PdfSyntaxError,
  Ref,
  Stream,
} from '../pdf/objects.ts';
import type { Box, Fill, Label, Layer, Sheet, Stroke } from './model.ts';
import { decodeLabels, visualToLogical } from './shx.ts';

type Matrix = [number, number, number, number, number, number];

/** A sheet may hold at most this many path coordinates. */
const MAX_COORDS = 12_000_000;
const MAX_LABELS = 200_000;
const MAX_FORM_DEPTH = 12;
/** The longest side a sheet may have, in points: 200 inches at a unit of 20. */
const MAX_SHEET = 288_000;
/** The most layers a sheet learns from its pages when the catalog lists none. */
const MAX_LAYERS = 10_000;
/** The most picture boxes a sheet keeps; the count goes on past it. */
const MAX_PICTURES = 5000;
/** Cells along each side when measuring how much pictures cover. */
const SHARE_CELLS = 100;

/**
 * How much of a sheet the boxes cover, from 0 to 1, on a grid of cells: a
 * box covers the cells whose centre it holds. Overlaps count once.
 */
export function pictureShare(
  boxes: readonly Box[],
  width: number,
  height: number,
): number {
  if (!boxes.length || width <= 0 || height <= 0) return 0;
  const n = SHARE_CELLS;
  const cells = new Uint8Array(n * n);
  let covered = 0;
  for (const b of boxes) {
    const c0 = Math.max(0, Math.ceil((b.x0 / width) * n - 0.5));
    const c1 = Math.min(n - 1, Math.floor((b.x1 / width) * n - 0.5));
    const r0 = Math.max(0, Math.ceil((b.y0 / height) * n - 0.5));
    const r1 = Math.min(n - 1, Math.floor((b.y1 / height) * n - 0.5));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        if (!cells[r * n + c]) {
          cells[r * n + c] = 1;
          covered++;
        }
    if (covered === n * n) break;
  }
  return covered / (n * n);
}
const CURVE_STEPS = 8;

export class DrawingTooLarge extends Error {
  constructor() {
    super('the page holds too much geometry');
    this.name = 'DrawingTooLarge';
  }
}

export class DeadlinePassed extends Error {
  constructor() {
    super('the deadline passed');
    this.name = 'DeadlinePassed';
  }
}

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/** Default user space to sheet coordinates. */
export function baseMatrix(page: Page): {
  matrix: Matrix;
  width: number;
  height: number;
} {
  const [x0, y0, x1, y1] = page.box;
  const u = page.userUnit;
  const w = (x1 - x0) * u;
  const h = (y1 - y0) * u;
  switch (page.rotate) {
    case 90:
      return { matrix: [0, u, u, 0, -u * y0, -u * x0], width: h, height: w };
    case 180:
      return { matrix: [-u, 0, 0, u, u * x1, -u * y0], width: w, height: h };
    case 270:
      return { matrix: [0, -u, -u, 0, u * y1, u * x1], width: h, height: w };
    default:
      return { matrix: [u, 0, 0, -u, -u * x0, u * y1], width: w, height: h };
  }
}

interface GState {
  ctm: Matrix;
  stroke: number;
  fill: number;
  width: number;
  dashed: boolean;
}

interface TextState {
  font: Font | null;
  size: number;
  tm: Matrix;
  tlm: Matrix;
  leading: number;
  charSpace: number;
  wordSpace: number;
  scale: number;
}

const num = (o: unknown): number => (typeof o === 'number' ? o : 0);

function toColor(parts: number[]): number | null {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  if (parts.length === 1) {
    const g = clamp(parts[0] as number);
    return (g << 16) | (g << 8) | g;
  }
  if (parts.length === 3)
    return (
      (clamp(parts[0] as number) << 16) |
      (clamp(parts[1] as number) << 8) |
      clamp(parts[2] as number)
    );
  if (parts.length === 4) {
    const k = 1 - (parts[3] as number);
    return (
      (clamp((1 - (parts[0] as number)) * k) << 16) |
      (clamp((1 - (parts[1] as number)) * k) << 8) |
      clamp((1 - (parts[2] as number)) * k)
    );
  }
  return null;
}

export interface ReadOptions {
  /** Epoch milliseconds after which reading stops with DeadlinePassed. */
  deadline?: number;
  now?: () => number;
}

/** The file's layers in catalog order, with those off by default marked. */
export function readLayers(doc: PdfDocument): {
  layers: Layer[];
  byObject: Map<number, number>;
} {
  const layers: Layer[] = [];
  const byObject = new Map<number, number>();
  const props = doc.dict(doc.catalog.get('OCProperties'));
  if (!props) return { layers, byObject };
  const config = doc.dict(props.get('D'));
  const off = new Set<number>();
  const base = config?.get('BaseState');
  const allOff = base instanceof Name && base.name === 'OFF';
  for (const o of doc.array(config?.get('OFF')))
    if (o instanceof Ref) off.add(o.num);
  const on = new Set<number>();
  for (const o of doc.array(config?.get('ON')))
    if (o instanceof Ref) on.add(o.num);
  for (const o of doc.array(props.get('OCGs'))) {
    if (!(o instanceof Ref) || byObject.has(o.num)) continue;
    const group = doc.dict(o);
    if (!group) continue;
    byObject.set(o.num, layers.length);
    layers.push({
      name: doc.text(group.get('Name')) ?? `layer ${layers.length + 1}`,
      hidden: allOff ? !on.has(o.num) : off.has(o.num),
    });
  }
  return { layers, byObject };
}

export function readSheet(
  doc: PdfDocument,
  pageIndex: number,
  options: ReadOptions = {},
): Sheet {
  const pages = doc.pages();
  const page = pages[pageIndex];
  if (!page) throw new RangeError('no such page');
  const now = options.now ?? Date.now;
  if (options.deadline !== undefined && now() > options.deadline)
    throw new DeadlinePassed();
  const { matrix: base, width, height } = baseMatrix(page);
  // A page is at most 200 inches a side times its unit; far more than that is
  // a damaged box, and would make every later step walk an absurd area.
  if (
    !(width > 0 && height > 0) ||
    !Number.isFinite(width + height) ||
    Math.max(width, height) > MAX_SHEET
  )
    throw new PdfSyntaxError('the page size is not usable');
  // Content far off the sheet is noise from a damaged file. Keep a margin of
  // one sheet on every side, and count what falls outside.
  const reach = Math.max(width, height);
  const within = (x: number, y: number): boolean =>
    x >= -reach && x <= width + reach && y >= -reach && y <= height + reach;
  let outside = 0;
  /** A label lies on or near the sheet and is no larger than it. */
  const labelFits = (box: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }): boolean =>
    within(box.x0, box.y0) &&
    within(box.x1, box.y1) &&
    box.x1 - box.x0 <= width &&
    box.y1 - box.y0 <= height;
  const { layers, byObject } = readLayers(doc);
  const strokes: Stroke[] = [];
  const fills: Fill[] = [];
  const texts: Label[] = [];
  const skipped = new Set<string>();
  let images = 0;
  const pictures: Box[] = [];
  // A picture fills the unit square of its transform.
  const picture = (ctm: Matrix) => {
    images++;
    if (pictures.length >= MAX_PICTURES) return;
    const xs = [
      ctm[4],
      ctm[0] + ctm[4],
      ctm[2] + ctm[4],
      ctm[0] + ctm[2] + ctm[4],
    ];
    const ys = [
      ctm[5],
      ctm[1] + ctm[5],
      ctm[3] + ctm[5],
      ctm[1] + ctm[3] + ctm[5],
    ];
    const x0 = Math.max(0, Math.min(...xs));
    const x1 = Math.min(width, Math.max(...xs));
    const y0 = Math.max(0, Math.min(...ys));
    const y1 = Math.min(height, Math.max(...ys));
    if (x1 > x0 && y1 > y0 && Number.isFinite(x0 + x1 + y0 + y1))
      pictures.push({ x0, y0, x1, y1 });
  };
  let coords = 0;
  const formCache = new Map<Stream, Uint8Array>();
  const fontCache = new Map<Dict, Font>();

  const layerOf = (resources: Dict, operand: Obj | Keyword | undefined) => {
    if (!(operand instanceof Name)) return -1;
    const properties = doc.dict(resources.get('Properties'));
    const target = properties?.get(operand.name);
    return ocLayer(target);
  };
  /** The layer an optional-content entry names; a membership names its first group. */
  const ocLayer = (target: Obj | undefined): number => {
    if (target instanceof Ref) {
      const known = byObject.get(target.num);
      if (known !== undefined) return known;
    }
    const dict = doc.dict(target);
    if (!dict) return -1;
    // A layer the catalog does not list: a tool that joins sheets into one
    // file drops the list, and each page still names its own layers.
    const type = dict.get('Type');
    if (
      target instanceof Ref &&
      type instanceof Name &&
      type.name === 'OCG' &&
      layers.length < MAX_LAYERS
    ) {
      byObject.set(target.num, layers.length);
      layers.push({
        name: doc.text(dict.get('Name')) ?? `layer ${layers.length + 1}`,
        hidden: false,
      });
      return layers.length - 1;
    }
    const groups = dict.get('OCGs');
    if (groups instanceof Ref) return ocLayer(groups);
    const list = doc.resolve(groups ?? null);
    if (Array.isArray(list))
      for (const g of list) {
        const found = ocLayer(g);
        if (found >= 0) return found;
      }
    return -1;
  };

  const run = (
    data: Uint8Array,
    resources: Dict,
    start: GState,
    outerLayer: number,
    depth: number,
  ): void => {
    const lex = new Lexer(data);
    const stack: GState[] = [];
    let gs: GState = { ...start };
    const layerStack: number[] = [];
    let layer = outerLayer;
    const operands: Array<Obj | Keyword> = [];
    // The path under construction, already in sheet coordinates.
    let subpaths: number[][] = [];
    let current: number[] | null = null;
    let startX = 0;
    let startY = 0;
    let curX = 0;
    let curY = 0;
    // After a close, the next line starts a subpath at the closed one's start.
    let reopen = false;
    const text: TextState = {
      font: null,
      size: 0,
      tm: [1, 0, 0, 1, 0, 0],
      tlm: [1, 0, 0, 1, 0, 0],
      leading: 0,
      charSpace: 0,
      wordSpace: 0,
      scale: 1,
    };
    let pending: {
      label: Label;
      endX: number;
      endY: number;
      dirX: number;
      dirY: number;
      em: number;
    } | null = null;
    const flushText = () => {
      const made = pending?.label;
      if (made?.raw.trim() && texts.length < MAX_LABELS) {
        if (labelFits(made)) texts.push(made);
        else outside++;
      }
      pending = null;
    };

    const tx = (x: number, y: number): [number, number] => [
      gs.ctm[0] * x + gs.ctm[2] * y + gs.ctm[4],
      gs.ctm[1] * x + gs.ctm[3] * y + gs.ctm[5],
    ];
    const moveTo = (x: number, y: number) => {
      const [X, Y] = tx(x, y);
      current = [X, Y];
      subpaths.push(current);
      startX = X;
      startY = Y;
      curX = x;
      curY = y;
      reopen = false;
    };
    const lineTo = (x: number, y: number) => {
      if (!current) {
        if (!reopen) return moveTo(x, y);
        current = [startX, startY];
        subpaths.push(current);
        reopen = false;
      }
      const [X, Y] = tx(x, y);
      current.push(X, Y);
      curX = x;
      curY = y;
    };
    const curveTo = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      x3: number,
      y3: number,
    ) => {
      if (!current) moveTo(x1, y1);
      const x0 = curX;
      const y0 = curY;
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const d = t * t * t;
        const [X, Y] = tx(
          a * x0 + b * x1 + c * x2 + d * x3,
          a * y0 + b * y1 + c * y2 + d * y3,
        );
        (current as number[]).push(X, Y);
      }
      curX = x3;
      curY = y3;
    };
    const closePath = () => {
      if (current && current.length >= 4) {
        current.push(startX, startY);
        current = null;
        reopen = true;
      }
    };
    const paint = (stroke: boolean, fill: boolean) => {
      const scale = Math.sqrt(
        Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]),
      );
      for (const pts of subpaths) {
        if (pts.length < 4) continue;
        let sane = true;
        for (let i = 0; i < pts.length && sane; i += 2)
          sane = within(pts[i] as number, pts[i + 1] as number);
        if (!sane) {
          outside++;
          continue;
        }
        coords += pts.length;
        if (coords > MAX_COORDS) throw new DrawingTooLarge();
        if (stroke)
          strokes.push({
            layer,
            color: gs.stroke,
            width: gs.width * scale,
            dashed: gs.dashed,
            pts,
          });
        if (fill && pts.length >= 6) {
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          let twice = 0;
          for (let i = 0; i < pts.length; i += 2) {
            const x = pts[i] as number;
            const y = pts[i + 1] as number;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            const j = (i + 2) % pts.length;
            twice += x * (pts[j + 1] as number) - (pts[j] as number) * y;
          }
          fills.push({
            layer,
            color: gs.fill,
            x0,
            y0,
            x1,
            y1,
            area: Math.abs(twice) / 2,
          });
        }
      }
      subpaths = [];
      current = null;
      reopen = false;
    };

    const showText = (bytes: Uint8Array) => {
      const font = text.font;
      if (!font) return;
      const shown = fontText(font, bytes);
      const m = mul(text.tm, gs.ctm);
      const stretch = Math.hypot(m[0], m[1]);
      if (!stretch) return;
      const dirX = m[0] / stretch;
      const dirY = m[1] / stretch;
      const em = text.size * Math.hypot(m[2], m[3]);
      const spaces = shown.text.split(' ').length - 1;
      const advance =
        ((shown.advance / 1000) * text.size +
          shown.codes * text.charSpace +
          spaces * text.wordSpace) *
        text.scale;
      const length = advance * stretch;
      const x = m[4];
      const y = m[5];
      // Up from the baseline, on the sheet.
      const upX = dirY;
      const upY = -dirX;
      const corners = [
        [x, y],
        [x + dirX * length, y + dirY * length],
        [x + upX * em, y + upY * em],
        [x + dirX * length + upX * em, y + dirY * length + upY * em],
      ] as const;
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const joins =
        pending &&
        Math.abs(pending.dirX - dirX) + Math.abs(pending.dirY - dirY) < 0.02 &&
        Math.abs(
          (x - pending.endX) * pending.dirY - (y - pending.endY) * pending.dirX,
        ) <
          0.3 * em &&
        (x - pending.endX) * dirX + (y - pending.endY) * dirY < em &&
        (x - pending.endX) * dirX + (y - pending.endY) * dirY > -0.5 * em;
      if (pending && joins) {
        const gap = (x - pending.endX) * dirX + (y - pending.endY) * dirY;
        const l = pending.label;
        l.raw += (gap > 0.25 * em ? ' ' : '') + shown.text;
        l.x0 = Math.min(l.x0, ...xs);
        l.y0 = Math.min(l.y0, ...ys);
        l.x1 = Math.max(l.x1, ...xs);
        l.y1 = Math.max(l.y1, ...ys);
        pending.endX = x + dirX * length;
        pending.endY = y + dirY * length;
      } else {
        flushText();
        pending = {
          label: {
            text: '',
            raw: shown.text,
            source: 'text',
            layer,
            x0: Math.min(...xs),
            y0: Math.min(...ys),
            x1: Math.max(...xs),
            y1: Math.max(...ys),
            vertical: Math.abs(dirY) > Math.abs(dirX),
          },
          endX: x + dirX * length,
          endY: y + dirY * length,
          dirX,
          dirY,
          em,
        };
      }
      text.tm = mul([1, 0, 0, 1, advance, 0], text.tm);
    };
    const nextLine = (dx: number, dy: number) => {
      text.tlm = mul([1, 0, 0, 1, dx, dy], text.tlm);
      text.tm = text.tlm;
    };

    for (let count = 0; ; count++) {
      if ((count & 0xffff) === 0xffff && options.deadline !== undefined) {
        if (now() > options.deadline) throw new DeadlinePassed();
      }
      const token = lex.read();
      if (token === undefined) break;
      if (!(token instanceof Keyword)) {
        operands.push(token);
        continue;
      }
      const a = operands;
      switch (token.word) {
        case 'm':
          moveTo(num(a[0]), num(a[1]));
          break;
        case 'l':
          lineTo(num(a[0]), num(a[1]));
          break;
        case 'c':
          curveTo(
            num(a[0]),
            num(a[1]),
            num(a[2]),
            num(a[3]),
            num(a[4]),
            num(a[5]),
          );
          break;
        case 'v':
          curveTo(curX, curY, num(a[0]), num(a[1]), num(a[2]), num(a[3]));
          break;
        case 'y':
          curveTo(
            num(a[0]),
            num(a[1]),
            num(a[2]),
            num(a[3]),
            num(a[2]),
            num(a[3]),
          );
          break;
        case 'h':
          closePath();
          break;
        case 're': {
          const x = num(a[0]);
          const y = num(a[1]);
          const w = num(a[2]);
          const h = num(a[3]);
          moveTo(x, y);
          lineTo(x + w, y);
          lineTo(x + w, y + h);
          lineTo(x, y + h);
          closePath();
          break;
        }
        case 'S':
          paint(true, false);
          break;
        case 's':
          closePath();
          paint(true, false);
          break;
        case 'f':
        case 'F':
        case 'f*':
          paint(false, true);
          break;
        case 'B':
        case 'B*':
          paint(true, true);
          break;
        case 'b':
        case 'b*':
          closePath();
          paint(true, true);
          break;
        case 'n':
          subpaths = [];
          current = null;
          reopen = false;
          break;
        case 'q':
          stack.push({ ...gs });
          break;
        case 'Q': {
          const saved = stack.pop();
          if (saved) gs = saved;
          break;
        }
        case 'cm':
          gs.ctm = mul(
            [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])],
            gs.ctm,
          );
          break;
        case 'w':
          gs.width = num(a[0]);
          break;
        case 'd':
          gs.dashed = Array.isArray(a[0]) && a[0].some((v) => num(v) > 0);
          break;
        case 'gs': {
          const states = doc.dict(resources.get('ExtGState'));
          const state =
            a[0] instanceof Name ? doc.dict(states?.get(a[0].name)) : null;
          const lw = doc.resolve(state?.get('LW') ?? null);
          if (typeof lw === 'number') gs.width = lw;
          const dash = doc.array(state?.get('D'));
          if (dash.length)
            gs.dashed = doc.array(dash[0]).some((v) => num(doc.resolve(v)) > 0);
          break;
        }
        case 'G':
        case 'RG':
        case 'K':
        case 'SC':
        case 'SCN': {
          const c = toColor(a.filter((v) => typeof v === 'number'));
          if (c !== null) gs.stroke = c;
          break;
        }
        case 'g':
        case 'rg':
        case 'k':
        case 'sc':
        case 'scn': {
          const c = toColor(a.filter((v) => typeof v === 'number'));
          if (c !== null) gs.fill = c;
          break;
        }
        case 'BDC': {
          const tag = a[0];
          const found =
            tag instanceof Name && tag.name === 'OC'
              ? layerOf(resources, a[1])
              : -1;
          layerStack.push(layer);
          if (found >= 0) layer = found;
          break;
        }
        case 'BMC':
          layerStack.push(layer);
          break;
        case 'EMC': {
          const outer = layerStack.pop();
          if (outer !== undefined) layer = outer;
          break;
        }
        case 'BT':
          text.tm = [1, 0, 0, 1, 0, 0];
          text.tlm = [1, 0, 0, 1, 0, 0];
          break;
        case 'ET':
          flushText();
          break;
        case 'Tf': {
          const fonts = doc.dict(resources.get('Font'));
          const dict =
            a[0] instanceof Name ? doc.dict(fonts?.get(a[0].name)) : null;
          text.size = num(a[1]);
          if (dict) {
            let font = fontCache.get(dict);
            if (!font) {
              font = readFont(doc, dict);
              fontCache.set(dict, font);
            }
            text.font = font;
          } else text.font = null;
          break;
        }
        case 'Tm':
          text.tlm = [
            num(a[0]),
            num(a[1]),
            num(a[2]),
            num(a[3]),
            num(a[4]),
            num(a[5]),
          ];
          text.tm = text.tlm;
          break;
        case 'Td':
          nextLine(num(a[0]), num(a[1]));
          break;
        case 'TD':
          text.leading = -num(a[1]);
          nextLine(num(a[0]), num(a[1]));
          break;
        case 'T*':
          nextLine(0, -text.leading);
          break;
        case 'TL':
          text.leading = num(a[0]);
          break;
        case 'Tc':
          text.charSpace = num(a[0]);
          break;
        case 'Tw':
          text.wordSpace = num(a[0]);
          break;
        case 'Tz':
          text.scale = num(a[0]) / 100 || 1;
          break;
        case 'Tj':
          if (a[0] instanceof PdfString) showText(a[0].bytes);
          break;
        case "'":
          nextLine(0, -text.leading);
          if (a[0] instanceof PdfString) showText(a[0].bytes);
          break;
        case '"':
          text.wordSpace = num(a[0]);
          text.charSpace = num(a[1]);
          nextLine(0, -text.leading);
          if (a[2] instanceof PdfString) showText(a[2].bytes);
          break;
        case 'TJ':
          if (Array.isArray(a[0]))
            for (const part of a[0]) {
              if (part instanceof PdfString) showText(part.bytes);
              else if (typeof part === 'number')
                text.tm = mul(
                  [1, 0, 0, 1, (-part / 1000) * text.size * text.scale, 0],
                  text.tm,
                );
            }
          break;
        case 'Do': {
          const xobjects = doc.dict(resources.get('XObject'));
          const target =
            a[0] instanceof Name
              ? doc.resolve(xobjects?.get(a[0].name) ?? null)
              : null;
          if (!(target instanceof Stream)) break;
          const subtype = target.dict.get('Subtype');
          if (subtype instanceof Name && subtype.name === 'Image') {
            picture(gs.ctm);
            break;
          }
          if (!(subtype instanceof Name && subtype.name === 'Form')) break;
          if (depth >= MAX_FORM_DEPTH) {
            skipped.add('content nested too deeply');
            break;
          }
          let content = formCache.get(target);
          if (!content) {
            content = doc.streamBytes(target);
            formCache.set(target, content);
          }
          const m = doc.numbers(target.dict.get('Matrix'));
          const inner: GState = {
            ...gs,
            ctm:
              m.length === 6
                ? mul(m as unknown as Matrix, gs.ctm)
                : ([...gs.ctm] as Matrix),
          };
          const own = ocLayer(target.dict.get('OC'));
          run(
            content,
            doc.dict(target.dict.get('Resources')) ?? resources,
            inner,
            own >= 0 ? own : layer,
            depth + 1,
          );
          break;
        }
        case 'BI': {
          // An inline image: skip its dictionary and its bytes.
          for (;;) {
            const t = lex.read();
            if (t === undefined || (t instanceof Keyword && t.word === 'ID'))
              break;
          }
          let p = lex.pos + 1;
          const end = data.length;
          while (p + 2 <= end) {
            if (
              data[p] === 69 &&
              data[p + 1] === 73 &&
              (data[p - 1] === 10 ||
                data[p - 1] === 13 ||
                data[p - 1] === 32) &&
              (p + 2 >= end ||
                data[p + 2] === 10 ||
                data[p + 2] === 13 ||
                data[p + 2] === 32)
            )
              break;
            p++;
          }
          lex.pos = Math.min(end, p + 2);
          picture(gs.ctm);
          break;
        }
        default:
          break;
      }
      operands.length = 0;
    }
    flushText();
  };

  const start: GState = {
    ctm: base,
    stroke: 0,
    fill: 0,
    width: 1,
    dashed: false,
  };
  run(doc.pageContent(page), page.resources, start, -1, 0);

  // Comments: stroke-font text kept by CAD programs, and people's notes.
  const comments: Label[] = [];
  for (const entry of doc.array(page.dict.get('Annots'))) {
    if (comments.length >= MAX_LABELS) break;
    const annot = doc.dict(entry);
    if (!annot) continue;
    const subtype = annot.get('Subtype');
    if (
      !(subtype instanceof Name) ||
      ['Link', 'Widget', 'Popup'].includes(subtype.name)
    )
      continue;
    const raw = doc.text(annot.get('Contents'));
    const rect = doc.numbers(annot.get('Rect'));
    if (!raw?.trim() || rect.length !== 4) continue;
    const [ax, ay, bx, by] = rect as [number, number, number, number];
    const p = [
      base[0] * ax + base[2] * ay + base[4],
      base[1] * ax + base[3] * ay + base[5],
      base[0] * bx + base[2] * by + base[4],
      base[1] * bx + base[3] * by + base[5],
    ] as const;
    const x0 = Math.min(p[0], p[2]);
    const x1 = Math.max(p[0], p[2]);
    const y0 = Math.min(p[1], p[3]);
    const y1 = Math.max(p[1], p[3]);
    if (!labelFits({ x0, y0, x1, y1 })) {
      outside++;
      continue;
    }
    const author = doc.text(annot.get('T')) ?? '';
    comments.push({
      text: '',
      raw,
      source: /SHX/i.test(author) ? 'shx' : 'note',
      layer: ocLayer(annot.get('OC')),
      x0,
      y0,
      x1,
      y1,
      vertical: raw.trim().length > 1 && y1 - y0 > (x1 - x0) * 1.2,
    });
  }
  decodeLabels(comments);
  for (const t of texts) t.text = visualToLogical(t.raw);

  return {
    page: pageIndex + 1,
    pages: pages.length,
    width,
    height,
    layers,
    strokes,
    fills,
    labels: [...comments, ...texts],
    images,
    pictures,
    pictureShare: pictureShare(pictures, width, height),
    skipped: outside
      ? [...skipped, `${outside} items far outside the sheet`]
      : [...skipped],
  };
}
