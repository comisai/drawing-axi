// A riser or fixture is often marked by a tag: a short identifier with the
// pipe size written under or over it, both inside one symbol ("O8" above
// "Ø110"). Pairing the two gives a count of vertical pipes per size.

import type { Label } from './model.ts';
import { sizeOf } from './sizes.ts';

export interface Tag {
  id: string;
  /** The letters the identifier starts with, or # for a number alone. */
  series: string;
  size: string;
  x: number;
  y: number;
}

const ID =
  /^(?:[A-Za-z\u05d0-\u05ea]{1,3}[-.]?\d{1,3}[A-Za-z]?|\d{1,3}[A-Za-z]?)$/;

export function findTags(labels: readonly Label[]): Tag[] {
  const ids: Label[] = [];
  const sizes: Array<{ label: Label; size: string }> = [];
  for (const label of labels) {
    const text = label.text.trim();
    const size = sizeOf(text);
    // A size written alone, with no slope or system prefix, belongs to a tag.
    if (size && /^\u00d8?\s*[\d./ ]+"?$/.test(text))
      sizes.push({ label, size });
    else if (ID.test(text)) ids.push(label);
  }
  const cell = 40;
  const grid = new Map<string, Label[]>();
  for (const id of ids) {
    const k = `${Math.floor((id.x0 + id.x1) / 2 / cell)},${Math.floor((id.y0 + id.y1) / 2 / cell)}`;
    const list = grid.get(k);
    if (list) list.push(id);
    else grid.set(k, [id]);
  }
  const used = new Set<Label>();
  const tags: Tag[] = [];
  for (const { label, size } of sizes) {
    const cx = (label.x0 + label.x1) / 2;
    const cy = (label.y0 + label.y1) / 2;
    const height = Math.min(label.y1 - label.y0, label.x1 - label.x0);
    let best: Label | null = null;
    let bestDistance = Infinity;
    const gx = Math.floor(cx / cell);
    const gy = Math.floor(cy / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (used.has(id)) continue;
          const ix = (id.x0 + id.x1) / 2;
          const iy = (id.y0 + id.y1) / 2;
          // Stacked: one above the other, about a text line apart.
          const across = Math.abs(ix - cx);
          const down = Math.abs(iy - cy);
          if (down > height * 1.8 || across > height * 1.5) continue;
          if (down < height * 0.3) continue;
          const d = Math.hypot(across, down);
          if (d < bestDistance) {
            best = id;
            bestDistance = d;
          }
        }
      }
    }
    if (!best) continue;
    used.add(best);
    const id = best.text.trim();
    tags.push({
      id,
      series: /^\d/.test(id) ? '#' : (/^[^\d\-.]+/.exec(id)?.[0] ?? '#'),
      size,
      x: (best.x0 + best.x1) / 2,
      y: (best.y0 + best.y1) / 2,
    });
  }
  return tags;
}
