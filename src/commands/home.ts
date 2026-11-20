// The home view: the drawings in the working folder, not help.

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandInput } from '../cli/table.ts';
import { baseMatrix, readLayers } from '../drawing/extract.ts';
import { MM_PER_PT } from '../drawing/model.ts';
import { render } from '../output/toon.ts';
import { countLine, type Row, tableRow } from '../output/views.ts';
import { binPath, MAX_FILE_BYTES, openPdf } from './common.ts';

export const DESCRIPTION =
  'Read CAD drawings saved as PDF: layers, labels, scale, pipe runs and counts';

const SHOWN = 20;

export function home(input: CommandInput): string {
  const dir = input.io.cwd;
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.pdf$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    names = [];
  }
  const rows: Row[] = names.slice(0, SHOWN).map((file) => {
    try {
      if (statSync(join(dir, file)).size > MAX_FILE_BYTES)
        return { file, sheet: 'too large to read' };
      const { doc } = openPdf(input.io, join(dir, file));
      const pages = doc.pages();
      const first = pages[0];
      const size = first ? baseMatrix(first) : null;
      return {
        file,
        pages: pages.length,
        sheet: size
          ? `${Math.round(size.width * MM_PER_PT)} x ${Math.round(size.height * MM_PER_PT)} mm`
          : null,
        layers: readLayers(doc).layers.length,
        comments: first ? doc.array(first.dict.get('Annots')).length : 0,
      };
    } catch {
      return { file, sheet: 'not readable' };
    }
  });
  const home = homedir();
  const folder =
    dir === home || dir.startsWith(`${home}/`)
      ? `~${dir.slice(home.length)}`
      : dir;
  const doc: Row = {
    bin: binPath(process.argv[1]),
    description: DESCRIPTION,
    folder,
    summary: names.length
      ? `${countLine(rows.length, names.length, 'PDF file')} in this folder`
      : 'no PDF files in this folder',
  };
  if (rows.length)
    doc.drawings = rows.map((r) =>
      tableRow(r, ['file', 'pages', 'sheet', 'layers', 'comments'], 120),
    );
  return render(
    doc,
    rows.length
      ? [
          'Run `drawing-axi info <file.pdf>` for what one drawing holds: layers, labels and scale',
          'Run `drawing-axi layers <file.pdf>` for its layers with the length drawn on each',
        ]
      : [
          'Run `drawing-axi info <path/to/file.pdf>` to read a drawing in another folder',
        ],
  );
}
