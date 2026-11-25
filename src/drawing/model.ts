// What one sheet of a drawing holds once it is read. All positions are in
// sheet coordinates: points from the top-left corner of the page as a viewer
// shows it, x to the right and y down.

export interface Layer {
  name: string;
  /** Switched off in the file's default view. */
  hidden: boolean;
}

export interface Stroke {
  /** Index into `Sheet.layers`, or -1 for content on no layer. */
  layer: number;
  /** 0xRRGGBB. */
  color: number;
  /** Line width in points. */
  width: number;
  /**
   * The dash pattern in points on the sheet, as on and off lengths joined by
   * dashes ("6-3"), or empty for a solid line.
   */
  dash: string;
  /** x0, y0, x1, y1, ... along the polyline. */
  pts: number[];
}

export interface Fill {
  layer: number;
  color: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Enclosed area in square points. */
  area: number;
}

export type LabelSource = 'shx' | 'text' | 'note';

export interface Label {
  /** The text as a person reads it. */
  text: string;
  /** The text as the file stores it. */
  raw: string;
  /**
   * shx: text drawn with a CAD stroke font and kept as a comment;
   * text: text in a real font; note: a comment a person added.
   */
  source: LabelSource;
  layer: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Reads up or down the sheet instead of across it. */
  vertical: boolean;
}

/** A box on the sheet, in points from the top-left corner. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Sheet {
  page: number;
  pages: number;
  width: number;
  height: number;
  layers: Layer[];
  strokes: Stroke[];
  fills: Fill[];
  labels: Label[];
  /** Font labels left out because a shown glyph could not be decoded. */
  unreadableText: number;
  images: number;
  /** Where pictures are drawn, clipped to the sheet; at most a few thousand. */
  pictures: Box[];
  /** How much of the sheet pictures cover, from 0 to 1. */
  pictureShare: number;
  /** Content the reader had to skip, in plain words. */
  skipped: string[];
}

export const colorHex = (color: number): string =>
  `#${color.toString(16).padStart(6, '0')}`;

/** #rgb or #rrggbb, with or without the hash; null when it is not a colour. */
export function parseColor(text: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const hex = m[1] as string;
  return Number.parseInt(
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex,
    16,
  );
}

export const MM_PER_PT = 25.4 / 72;

/** A line width to the hundredth of a point, the step line styles are told apart by. */
export const widthKey = (width: number): number => Math.round(width * 100);

/** "w0.70 solid" or "w0.35 dash6-3": a stroke's width in points and its dash. */
export const styleText = (stroke: Stroke): string =>
  `w${(widthKey(stroke.width) / 100).toFixed(2)} ${stroke.dash ? `dash${stroke.dash}` : 'solid'}`;

/** A colour whose red, green and blue are within this much of each other is a grey. */
const GREY_SPREAD = 6;

export function isGrey(color: number): boolean {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  return Math.max(r, g, b) - Math.min(r, g, b) <= GREY_SPREAD;
}
