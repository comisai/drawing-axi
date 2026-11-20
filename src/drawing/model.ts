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
  /** Drawn with a dash pattern, so its gaps are not gaps in the object. */
  dashed: boolean;
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
