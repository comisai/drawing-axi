// A picture of part of a sheet, as SVG text: chosen layers in their own
// colours, with labels and a coordinate grid if asked. An agent turns it into
// an image and looks at it when names and numbers are not enough.

import type { Box, Label, Stroke } from './model.ts';

export interface SvgOptions {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Where the sheet's own pictures are; drawn as outlined boxes. */
  pictures?: readonly Box[];
  /** Width of the picture in pixels. */
  width: number;
  /** Fit both dimensions within this many pixels for raster previews. */
  maxSide?: number;
  labels: boolean;
  grid: boolean;
}

/** The most path coordinates one picture may hold. */
export const MAX_SVG_COORDS = 1_500_000;
// A bounded raster preview can take denser sheets than SVG exports.
const MAX_PREVIEW_COORDS = 3_000_000;

export class PictureTooLarge extends Error {
  constructor() {
    super('the picture holds too much geometry');
    this.name = 'PictureTooLarge';
  }
}

/** XML allows no control characters other than tab, line feed and return. */
const xmlSafe = (text: string): string =>
  [...text]
    .filter((c) => {
      const n = c.codePointAt(0) as number;
      return (
        (n >= 32 && n <= 0xd7ff && n !== 127) ||
        (n >= 0xe000 && n <= 0xfffd) ||
        n >= 0x10000 ||
        n === 9 ||
        n === 10 ||
        n === 13
      );
    })
    .join('');

const escapeXml = (text: string): string =>
  xmlSafe(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const n1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/** Near-white ink is drawn black: CAD "white" is the paper's opposite. */
function ink(color: number): string {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  if (r > 235 && g > 235 && b > 235) return '#000000';
  return `#${color.toString(16).padStart(6, '0')}`;
}

function niceStep(span: number): number {
  const raw = span / 8;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

export function renderSvg(
  strokes: readonly Stroke[],
  labels: readonly Label[],
  options: SvgOptions,
): {
  svg: string;
  strokes: number;
  labels: number;
  width: number;
  height: number;
} {
  const { x0, y0, x1, y1 } = options;
  const w = x1 - x0;
  const h = y1 - y0;
  const preview = options.maxSide !== undefined;
  const zoom = Math.min(
    options.width / w,
    (options.maxSide ?? Infinity) / Math.max(w, h),
  );
  const width = preview ? Math.max(1, Math.round(w * zoom)) : options.width;
  const height = Math.max(1, Math.round(h * zoom));
  const ptPerPx = Math.max(w / width, h / height);
  const limit = preview ? MAX_PREVIEW_COORDS : MAX_SVG_COORDS;
  const paths = new Map<string, string[]>();
  let coords = 0;
  let shown = 0;
  for (const stroke of strokes) {
    const p = stroke.pts;
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i] as number;
      const y = p[i + 1] as number;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
    if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
    coords += p.length;
    if (coords > limit) throw new PictureTooLarge();
    shown++;
    // Hairlines stay visible however far the picture is zoomed out.
    const key = `${ink(stroke.color)}|${n1(Math.max(stroke.width, ptPerPx * 0.8))}`;
    let d = `M${n1(p[0] as number)} ${n1(p[1] as number)}`;
    for (let i = 2; i < p.length; i += 2)
      d += `L${n1(p[i] as number)} ${n1(p[i + 1] as number)}`;
    const list = paths.get(key);
    if (list) list.push(d);
    else paths.set(key, [d]);
  }
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x0} ${y0} ${w} ${h}">`,
    `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#ffffff"/>`,
  ];
  // The sheet's own pictures are not drawn; a box with a cross shows where
  // each one is, so lines missing from the picture are not taken for absent.
  const inside = (options.pictures ?? []).filter(
    (b) => b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1,
  );
  if (inside.length) {
    const line = n1(ptPerPx * 0.6);
    out.push(
      `<g fill="#f2f2f2" stroke="#b0b0b0" stroke-width="${line}"><title>picture: not drawn</title>`,
    );
    for (const b of inside)
      out.push(
        `<rect class="picture" x="${n1(b.x0)}" y="${n1(b.y0)}" width="${n1(b.x1 - b.x0)}" height="${n1(b.y1 - b.y0)}"/><path fill="none" d="M${n1(b.x0)} ${n1(b.y0)}L${n1(b.x1)} ${n1(b.y1)}M${n1(b.x1)} ${n1(b.y0)}L${n1(b.x0)} ${n1(b.y1)}"/>`,
      );
    out.push('</g>');
  }
  if (options.grid) {
    const step = niceStep(Math.max(w, h));
    const size = n1(ptPerPx * 11);
    out.push(
      `<g stroke="#c8c8c8" stroke-width="${n1(ptPerPx * 0.6)}" fill="#808080" font-family="sans-serif" font-size="${size}">`,
    );
    // niceStep gives at most eight intervals per axis. Bound the loops
    // independently of floating-point progress when a region is tiny.
    for (let i = 0; i <= 8; i++) {
      const x = (Math.ceil(x0 / step) + i) * step;
      if (!(x <= x1)) break;
      out.push(
        `<path d="M${n1(x)} ${n1(y0)}L${n1(x)} ${n1(y1)}"/><text x="${n1(x + ptPerPx * 3)}" y="${n1(y0 + ptPerPx * 12)}" stroke="none">${x}</text>`,
      );
    }
    for (let i = 0; i <= 8; i++) {
      const y = (Math.ceil(y0 / step) + i) * step;
      if (!(y <= y1)) break;
      out.push(
        `<path d="M${n1(x0)} ${n1(y)}L${n1(x1)} ${n1(y)}"/><text x="${n1(x0 + ptPerPx * 3)}" y="${n1(y - ptPerPx * 3)}" stroke="none">${y}</text>`,
      );
    }
    out.push('</g>');
  }
  for (const [key, list] of paths) {
    const [color, width] = key.split('|');
    out.push(
      `<path fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" d="${list.join('')}"/>`,
    );
  }
  let labelled = 0;
  if (options.labels) {
    out.push(
      '<g fill="#202020" font-family="sans-serif" text-anchor="middle">',
    );
    for (const label of labels) {
      if (label.x1 < x0 || label.x0 > x1 || label.y1 < y0 || label.y0 > y1)
        continue;
      const cx = (label.x0 + label.x1) / 2;
      const cy = (label.y0 + label.y1) / 2;
      const size = Math.max(
        1,
        Math.min(label.x1 - label.x0, label.y1 - label.y0) * 0.7,
      );
      const turn = label.vertical
        ? ` transform="rotate(-90 ${n1(cx)} ${n1(cy)})"`
        : '';
      out.push(
        `<text x="${n1(cx)}" y="${n1(cy + size * 0.35)}" font-size="${n1(size)}"${turn}>${escapeXml(label.text)}</text>`,
      );
      labelled++;
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return {
    svg: `${out.join('\n')}\n`,
    strokes: shown,
    labels: labelled,
    width,
    height,
  };
}
