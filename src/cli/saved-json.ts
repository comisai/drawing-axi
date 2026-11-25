// TypeScript-style shapes for --save files. A question mark marks a key that
// may be absent. Coordinates are PDF points from the top-left of the sheet.
const xy = 'x: number, y: number';
const box = '{x0: number, y0: number, x1: number, y1: number}';
const scale =
  "ratio: number, pt_per_m: number, basis: 'flag' | 'bar' | 'label'";
const labelPage = 'file: string, text_status?: string';
const tag = `{tag: string, series: string, size: string, ${xy}}`;

export const SAVED_JSON: Readonly<Record<string, string[]>> = {
  scale: [
    '{file: string, scale: string, pt_per_m: number, basis: string, scale_bar: string | null, plotted_at: string | null, stated: string, sheet_covers: string, one_metre: string}',
  ],
  layers: [
    '{file: string, scale: string, ink?: string, layers: {layer: string, run_m: number | null, strokes: number, color: string}[]}',
    '--by style: each layer is named as --layer takes it, such as (no layer)@#666666 w0.70 solid, and has no color key.',
    'The ink key is present when the ink is all or almost all greys and the split is not by style.',
  ],
  legend: [
    '{file: string, box: string | null, legend: {text: string, layer: string, color: string, at: string}[]}',
  ],
  labels: [
    `Default: {${labelPage}, labels: {text: string, count: number, at: string}[]}`,
    `--each: {${labelPage}, labels: {text: string, ${xy}, source: 'shx' | 'text' | 'note', stored?: string | null}[]}`,
    `--sizes (takes precedence over --each): {${labelPage}, sizes: {code: string, size: string, slope: string, labels: number}[]}`,
    'The stored key is present with --each --full. The text_status key is present when font text could not be decoded.',
  ],
  tags: [
    `Default: {file: string, tags: {series: string, size: string, count: number, tags: string}[], places: ${tag}[]}`,
    `--each: {file: string, tags: ${tag}[]}`,
  ],
  runs: [
    `{file: string, scale: {${scale}}, runs: {group: string, length_m: number, from: string, to: string, pieces: number}[]}`,
    'The from and to strings hold x,y coordinates.',
  ],
  measure: [
    `{file: string, page: number, scale: {${scale}, text: string}, size_labels: string, pictures?: string, gaps?: string, settings_text: string,`,
    ` settings: {gap_mm: number, min_mm: number, reach_mm: number, plain_size_labels: boolean, region: ${box} | null, exclude: ${box}[]},`,
    ' groups: {group: string, length_m: number, runs: number, sized_m: number, unsized_m: number, layers: string[]}[],',
    ` unplaced: {label: string, size: string, code: string | null, ${xy}}[],`,
    ' sizes: {group: string, size: string, length_m: number, labelled_m: number | null, runs: number}[],',
    ' labels: {group: string, size: string, label: string, labelled_m: number, runs: number}[],',
    ' labels_apart: {group: string, size: string, label: string, labels: number}[],',
    " runs: {group: string, layer?: string, size: string | null, basis: 'label' | 'neighbour' | 'none', label: string | null, length_m: number, from: [number, number], to: [number, number]}[]}",
  ],
  symbols: [
    `{file: string, symbols: {size: string, parts: number, count: number, first_at: string, layer: string}[], places: {layer: string, size: string, parts: number, ${xy}}[]}`,
  ],
};
