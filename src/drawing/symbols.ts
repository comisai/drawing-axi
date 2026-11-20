// Symbols (valves, drains, hose reels) are small groups of strokes and fills
// that sit close together. Grouping what touches, then counting groups of the
// same size and make-up, gives a count per kind of symbol.

import type { Fill, Stroke } from './model.ts';

export interface SymbolGroup {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Strokes and fills in the group. */
  parts: number;
}

export interface SymbolOptions {
  /** Pieces this close belong to one symbol, in points. */
  join: number;
  /** A piece larger than this is a line, not part of a symbol, in points. */
  maxPiece: number;
}

export function groupSymbols(
  strokes: readonly Stroke[],
  fills: readonly Fill[],
  options: SymbolOptions,
): SymbolGroup[] {
  const boxes: SymbolGroup[] = [];
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    if (x1 - x0 > options.maxPiece || y1 - y0 > options.maxPiece) return;
    boxes.push({ x0, y0, x1, y1, parts: 1 });
  };
  for (const stroke of strokes) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const p = stroke.pts;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i] as number;
      const y = p[i + 1] as number;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    add(x0, y0, x1, y1);
  }
  for (const f of fills) add(f.x0, f.y0, f.x1, f.y1);
  boxes.sort((a, b) => a.x0 - b.x0);
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    while (parent[i] !== r) {
      const next = parent[i] as number;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const join = options.join;
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i] as SymbolGroup;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j] as SymbolGroup;
      if (b.x0 > a.x1 + join) break;
      if (b.y0 > a.y1 + join || b.y1 < a.y0 - join) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const groups = new Map<number, SymbolGroup>();
  boxes.forEach((box, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (!g) groups.set(r, { ...box });
    else {
      g.x0 = Math.min(g.x0, box.x0);
      g.y0 = Math.min(g.y0, box.y0);
      g.x1 = Math.max(g.x1, box.x1);
      g.y1 = Math.max(g.y1, box.y1);
      g.parts++;
    }
  });
  return [...groups.values()];
}
