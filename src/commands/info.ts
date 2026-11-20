// `info`: what one sheet holds and whether it can be measured. `scale`: the
// scale and how it was found.

import type { CommandInput } from '../cli/table.ts';
import { MM_PER_PT } from '../drawing/model.ts';
import { nominalPtPerM, type Scale } from '../drawing/scale.ts';
import { sizeLabels } from '../drawing/sizes.ts';
import { AxiError } from '../errors.ts';
import { type Row, recordOutput } from '../output/views.ts';
import {
  openSheet,
  PICTURED,
  percent,
  round,
  save,
  scaleOf,
  sheetSize,
  str,
} from './common.ts';

/** How the scale was found, in words. */
function basisText(scale: Scale): string {
  if (scale.basis === 'flag' && !scale.bar)
    return scale.given && scale.ptPerM !== nominalPtPerM(scale.ratio)
      ? 'points per metre given by flag'
      : 'given ratio; no scale bar found';
  const ratio = scale.given ? 'given ratio' : 'stated ratio';
  return scale.basis === 'bar'
    ? `${ratio}, refined by the scale bar`
    : `${ratio}; no scale bar found`;
}

/** "1:100, 27.98 pt per m (stated ratio, refined by the scale bar)". */
export function scaleLine(scale: Scale): string {
  return `1:${scale.ratio}, ${round(scale.ptPerM, 2)} pt per m (${basisText(scale)})`;
}

export function info(input: CommandInput): string {
  const opened = openSheet(input);
  const { sheet, doc } = opened;
  const count = { shx: 0, text: 0, note: 0 };
  for (const label of sheet.labels) count[label.source]++;
  const sizes = sizeLabels(sheet.labels);
  let scale: string;
  try {
    scale = scaleLine(scaleOf(input.values, sheet));
  } catch (error) {
    if (!(error instanceof AxiError) || error.code !== 'scale_unknown')
      throw error;
    scale =
      'not stated on the sheet; pass --scale 1:N to the measuring commands';
  }
  const meta = doc.dict(doc.trailer.get('Info'));
  const hidden = sheet.layers.filter((l) => l.hidden).length;
  const used = new Set(
    sheet.strokes.filter((s) => s.layer >= 0).map((s) => s.layer),
  ).size;
  const notes: string[] = [];
  // Most of the page a picture: whatever lines the file holds are what was
  // drawn over it, such as a grid, so no advice about layers or colours.
  const pictured = sheet.pictureShare >= PICTURED;
  if (!sheet.strokes.length && sheet.images)
    notes.push(
      'This page is a picture, such as a scan: it holds no lines to measure. Ask for the PDF plotted from the CAD file.',
    );
  else if (pictured)
    notes.push(
      `Pictures cover ${percent(sheet.pictureShare)} of this page: the drawing is a picture. A pipe drawn in a picture is not a line, so it is not measured, and \`render\` shows only where the pictures are. Ask for the PDF plotted from the CAD file, not a print of it.`,
    );
  else if (!sheet.strokes.length) notes.push('This page holds no lines.');
  if (!pictured && sheet.strokes.length && sheet.layers.length && !used)
    notes.push(
      'No line on this page is on a layer. Tell systems apart by colour: `drawing-axi layers <file.pdf> --split`.',
    );
  if (!pictured && sheet.strokes.length && !sheet.layers.length)
    notes.push(
      'The file keeps no layers. Tell systems apart by colour: `drawing-axi layers <file.pdf> --split`.',
    );
  if (sheet.strokes.length && !sheet.labels.length)
    notes.push(
      'The file keeps no text. Sizes and names must come from looking at the sheet: `drawing-axi render`.',
    );
  if (doc.rebuilt)
    notes.push('The file was damaged; its object table was rebuilt.');
  for (const s of sheet.skipped) notes.push(`Skipped: ${s}.`);
  const record: Row = {
    file: opened.name,
    page: `${sheet.page} of ${sheet.pages}`,
    sheet: sheetSize(sheet),
    made_by: [doc.text(meta?.get('Creator')), doc.text(meta?.get('Producer'))]
      .filter(Boolean)
      .join(' / '),
    scale,
    layers: `${used} with ink on this page, ${sheet.layers.length} in the file${hidden ? ` (${hidden} switched off)` : ''}`,
    geometry: `${sheet.strokes.length} strokes, ${sheet.fills.length} fills, ${sheet.images} images`,
    ...(sheet.images
      ? {
          pictures: `${sheet.images}, covering ${percent(sheet.pictureShare)} of the page`,
        }
      : {}),
    labels: `${count.shx} stroke-font, ${count.text} font text, ${count.note} notes`,
    size_labels: `${sizes.length} (${sizes.filter((s) => s.onRun).length} carry a slope or a system code, as a label on a pipe does)`,
    notes,
  };
  return recordOutput(
    record,
    input.values.full === true,
    'drawing-axi layers',
    [
      sheet.pages > 1
        ? `Run \`drawing-axi info <file.pdf> --page <n>\` for another of the ${sheet.pages} pages; every command takes --page`
        : 'Run `drawing-axi scale <file.pdf>` for how the scale was found',
      'Run `drawing-axi legend <file.pdf>` for which layer each legend line stands for',
      'Run `drawing-axi layers <file.pdf>` for the layers with the length drawn on each',
    ],
  );
}

export function scale(input: CommandInput): string {
  const { sheet, name } = openSheet(input);
  const found = scaleOf(input.values, sheet);
  const factor = found.ptPerM / nominalPtPerM(found.ratio);
  const record: Row = {
    file: name,
    scale: `1:${found.ratio}`,
    pt_per_m: round(found.ptPerM, 3),
    basis: basisText(found),
    scale_bar: found.bar
      ? `${found.bar.metres} m in ${found.bar.cells} cells at x=${Math.round(found.bar.x)} y=${Math.round(found.bar.y)}`
      : null,
    plotted_at:
      Math.abs(factor - 1) > 0.002
        ? `${round(factor * 100, 1)}% of the stated scale`
        : null,
    stated: found.stated.map((r) => `1:${r}`).join(', ') || 'none',
    sheet_covers: `${round(sheet.width / found.ptPerM, 1)} x ${round(sheet.height / found.ptPerM, 1)} m`,
    one_metre: `${round(found.ptPerM * MM_PER_PT, 2)} mm on paper`,
  };
  const saved = save(input.io, str(input.values, 'save'), record);
  if (saved) record.saved = saved;
  return recordOutput(record, true, 'drawing-axi scale', [
    'Run `drawing-axi measure <file.pdf> --group <name>=<layer> --group <name>=<layer>` to measure with this scale',
  ]);
}
