# drawing-axi

[![CI](https://github.com/comisai/drawing-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/comisai/drawing-axi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/drawing-axi.svg)](https://www.npmjs.com/package/drawing-axi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A command-line tool that lets AI agents read CAD drawings saved as PDF: the layers, the labels, the scale, the length of pipe on each layer by size, riser tags, symbols and the legend. It is built for quantity takeoff: turning a plumbing, fire or drainage plan into the rows of a bill of quantities.

A PDF plotted from a CAD program keeps much more than a picture. It keeps the drawing's named layers, one per system. It keeps every label as hidden text with its position. A text extractor and a rendered image show neither, so an agent that reads the sheet that way measures by colour and counts by eye. drawing-axi reads what the file really holds.

drawing-axi is an AXI, an [agent experience interface](https://axi.md). Every command:
- prints compact [TOON](https://github.com/toon-format/toon) text on stdout, bounded in size;
- refuses bad input and says exactly what is wrong;
- ends with hints for the next command, as a TOON list, so the whole output decodes as one document;
- reads one local file and never uses the network.

It was built to run inside Comis, and it also works on its own.

> **Status:** early development (0.x). Checked against eight sheets from one design office, where every measured system was within 10% of a person's takeoff. Drawings from other offices may keep less in the file; `drawing-axi info` says what a sheet holds before you rely on it. A takeoff made with this tool is a draft for a person to check, not a signed bill.

## Requirements

- Node.js 22.18 or later.
- Drawings plotted to PDF from the CAD file (vector PDF), one sheet a page; a file that joins several sheets works too, `--page` picks one. A scan or a photo holds no lines to measure, and the tool says so. So does a print of the drawing through a PDF printer, where the drawing becomes picture tiles under a few real lines such as the column grid: `info` says how much of the page pictures cover, `measure` warns, and `render` shows where the pictures are.

## Install

```sh
npm install -g drawing-axi
```

Each release is published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so you can check that it was built from this repository. To run from source instead, see [Development](#development).

## Usage

```text
drawing-axi                               home view: the PDF drawings in this folder
drawing-axi info <file.pdf>               what a sheet holds: size, scale, layers, labels, what is missing
drawing-axi scale <file.pdf>              the scale and how it was found
drawing-axi legend <file.pdf>             legend lines paired with the layer and colour of their samples
drawing-axi layers <file.pdf>             layers with the length of straight runs drawn on each
drawing-axi labels <file.pdf>             the text on the sheet: legend, notes, sizes
drawing-axi tags <file.pdf>               riser tags with the size written beside each
drawing-axi runs <file.pdf> --layer L     the straight runs on chosen layers, with their ends
drawing-axi measure <file.pdf> --group name=LAYER[+LAYER]...
                                          run length by group and pipe size
drawing-axi symbols <file.pdf> --layer L  symbols counted by size and make-up
drawing-axi render <file.pdf> --out f.svg a picture of chosen layers and area, to look at
drawing-axi help <command>                flags for one command
```

Positions are `x,y` in points from the top-left corner of the sheet, x to the right and y down. 72 points are one inch on paper.

### A takeoff, step by step

These are the outputs for the sample sheet the tests draw (`test/fixtures/sample.ts`).

```sh
drawing-axi info plan.pdf
```

```text
file: plan.pdf
page: 1 of 2
sheet: 494 x 317 mm
scale: "1:100, 27.78 pt per m (stated ratio, refined by the scale bar)"
layers: "9 with ink on this page, 9 in the file (1 switched off)"
geometry: "243 strokes, 2 fills, 0 images"
labels: "24 stroke-font, 1 font text, 1 notes"
size_labels: "9 (4 carry a slope or a system code, as a label on a pipe does)"
```

```sh
drawing-axi legend plan.pdf
```

```text
summary: 4 legend lines paired with the layer its sample is drawn on
box: "1050,93,1360,202"
legend[4]{text,layer,color,at}:
  צנרת ביוב,SEWER,"#ff00ff","1280,110"
  צנרת ניקוז מי גשם,RAIN,"#00bfff","1280,135"
  צנרת מים כבוי אש (F),FIRE,"#ff0000","1280,160"
  צנרת מים קרים,WATER,"#00ffff","1280,185"
```

The captions read sewer pipe, rainwater drain pipe, fire water pipe (F) and cold water pipe. The file stores them as `mbr, chuc` and the like: the keys a drafter typed in a Hebrew stroke font.

```sh
drawing-axi measure plan.pdf --group sewer=SEWER --group rain=RAIN --group fire=FIRE \
  --exclude 1050,93,1360,202 --save takeoff.json
```

```text
summary: "3 groups, 70 m in 6 runs"
scale: "1:100, 27.78 pt per m (stated ratio, refined by the scale bar)"
size_labels: "3 of 4 size labels in the area sit on a measured run; the others belong to pipe that is not in these groups, or fit no run"
groups[3]{group,length_m,runs,sized_m,unsized_m}:
  sewer,43,4,38,5
  rain,12,1,12,0
  fire,15,1,0,15
sizes[5]{group,size,length_m,labelled_m,runs}:
  sewer,Ø160,30,20,2
  sewer,Ø200,8,8,1
  sewer,unsized,5,null,1
  rain,Ø110,12,12,1
  fire,unsized,15,null,1
sized_by[3]{group,size,label,labelled_m,runs}:
  sewer,Ø160,Ø160-1%,20,1
  sewer,Ø200,Ø200-1%,8,1
  rain,Ø110,Ø110-2%,12,1
```

`box` is the legend's own area: the legend holds sample lines on the pipe layers, so a takeoff leaves it out. The fourth size label belongs to the water pipe, which this command did not measure. `sized_by` shows which label sized what, so a label of another system on a row is a wrong pairing to check. `--save` writes every run with its group, size, label and ends as JSON, to a thousandth of a metre, so a program can build the workbook without retyping numbers.

### What the numbers mean

- **Runs.** A pipe is plotted as dashes, and broken where a letter or a label sits on it. A run joins pieces that lie on one line and end near each other, and is measured end to end. A break with a linetype letter in it, such as the F of a fire line, is joined up to twice as wide. Some offices plot those letters as strokes on the pipe's layer; their bars join into a sparse line a point or two off the pipe, which is left out and counted in `settings`. When a group's runs would grow by a fifth at a gap half as wide again, `gaps` says so; `--group-gap NAME=MM` sets a gap for that group alone. Curved pipe and runs shorter than 6 mm on paper are left out.
- **Scale.** The ratio comes from the title block. A scale bar can refine it by up to 2%. A larger difference needs confirmation from a separate dimension. `drawing-axi scale` shows the factor used, why it was chosen, and the bar's length in points, printed label when readable, and implied factor. Pass `--scale 1:N` or `--pt-per-m` when the sheet is wrong or silent.
- **Sizes.** A run takes the size of a label written along it: just beside the line, or in a break left in the line for it. A line that passes through the middle of a label's text is another pipe, and takes nothing. A run without a label takes the size of the runs of its own group that it touches, when they all agree. `labelled_m` is the part sized by a label of its own.
- **System codes.** A label such as `F-Ø4"` or `CW1-Ø3"` starts with its system's code. Name a group by that code (`--group F=<layer>`, `--group CW=<layer>`) and it takes only those labels and sizes written alone, never a slope label such as `Ø160-1%`, which is a gravity pipe's. No other group takes its labels. The code is the letters before the first digit, dots left out: `C.W.2` is `CW`, `OD7A` is `OD`. A label written in a break of a line still sizes that line, whatever its group is called. A coded label that sits on no run, as one on a leader does, is listed under `labels_apart`: the sheet names that size for the system, and does not say which pipe. It is a size to confirm, not a measured one.
- **Unsized.** What no label sizes is reported as `unsized`. The tool never guesses a size. `size_labels` says how many more labels a reach twice as wide would place, for an office that writes its sizes a few millimetres off the pipe. `--plain` adds sizes written alone, such as `Ø63`, that no riser tag claims.
- **Not on a plan.** Vertical lengths, fittings, hangers and insulation are not drawn to scale on a plan. `tags` and `symbols` count what the sheet marks; the rest needs rules or a person.

### Hebrew and PDF font text

CAD stroke fonts keep text in the file as the keys the drafter typed. drawing-axi turns `%%C` into Ø, reads Hebrew typed on Latin keys, puts digits stored back to front in reading order, and leaves Latin text alone. `labels --each --full` adds the stored text wherever decoding changed it.

When the PDF’s Unicode map is missing or maps a glyph to a control character, drawing-axi tries the font’s encoding. This includes numbered glyphs from legacy Hebrew fonts that store Windows-1255 bytes. If any font labels still cannot be decoded, `labels` leaves them out and reports `text_status` for the selected page, including in `--save` JSON. Ask for a PDF re-exported with selectable text.

## Exit codes and errors

`0` success, `1` an error, `2` a usage error. An error prints `message`, `code` and `usage` on stdout:

| Code | Meaning |
| --- | --- |
| `usage` | A bad flag or argument |
| `not_found`, `not_pdf` | No file there, or not a PDF |
| `encrypted`, `damaged`, `unsupported` | The PDF cannot be read as it is; the message names a `qpdf` command that fixes it |
| `too_large`, `timed_out` | More than the tool reads at once, or than the caller's deadline allows |
| `no_page`, `unknown_layer` | The page or layer does not exist; the message lists what does |
| `scale_unknown` | The sheet states no scale; pass `--scale` |
| `exists` | `render --out` would replace a file; add `--force` |

## Safety

- It reads the file you name and writes only the files you name with `--out` and `--save`. It opens no network connection.
- A drawing is untrusted input. File size, decoded size, nesting and geometry are bounded, and a damaged file fails with an error.
- Text from the file is data. Invisible and bidirectional-control characters are shown as escapes, so a label cannot hide or reorder output.

## Development

```sh
git clone https://github.com/comisai/drawing-axi.git
cd drawing-axi
npm ci
npm run check       # type-check, lint, unit, contract and AXI-principle tests
npm run build       # dist/bin/drawing-axi.js
npm run test:dist   # contract and AXI-principle tests against the built CLI
```

Tests draw their own sample sheet (`test/fixtures/`). No real drawing is in this repository. See [CONTRIBUTING](CONTRIBUTING.md) for the rules and the live test, and [docs/](docs/) for the design, the implementation plan and the master plan.

## License

[MIT](LICENSE). See [NOTICE](NOTICE).
