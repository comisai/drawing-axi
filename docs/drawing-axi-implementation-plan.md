# drawing-axi: implementation plan

| | |
| --- | --- |
| Status | T1 to T30 done (2026-11-20): the tool, releases 0.1.0 to 0.1.3, the Comis pack and the live scenario. Version 0.1.4 is prepared for release. §7.3 lists the next version's work. |
| Date | 2026-11-20 |
| Design | `drawing-axi-design.md` |
| Master plan | `drawing-axi-master-plan.md` (milestones, gates, owner actions) |

## 1. Summary

`drawing-axi` is a Node command-line tool, published to npm, that reads a CAD drawing saved as PDF and answers the questions a quantity takeoff asks. It follows the shape of `ituran-axi` and `priority-axi`: TypeScript run directly by Node, one command table, TOON output from the official encoder, one runtime dependency, tests that run the CLI as a separate process, and a live test kept apart from CI.

What is different here is the input. The other two read a service through the Comis Gate. This one reads a file, so it needs no credential and no Gate entry. Its hard part is the file format and the geometry, and its risk is untrusted input.

## 2. Check on real drawings, 2026-11-20

A prototype of about 490 lines of Python, on the PDF library already in the Comis workbench, answered the first question: is the information in the file? It is (design §2, F1 to F15). The prototype's totals for six systems on one sheet came close to a person's takeoff, and it ran in about two seconds a sheet.

### 2.1 Findings that changed the design

| ID | Finding | Change |
| --- | --- | --- |
| P1 | Raw stroke length on a layer undercounts dashed pipes by 20 to 50%. | Runs are joined and measured end to end (design §7.4). |
| P2 | The prototype lost a run of over 20 m where a dot-sized stroke sat at a corner: it joined two runs into one and measured only the longer. | Strokes under 0.3 points are dropped before joining. Cold water on that sheet went from 9% under a person's figure to 3% over it. |
| P3 | Giving a run the size of the nearest label put sewer sizes on fire and water pipes, and neighbours then spread them further. | A label fits one run, beside it or in a break in it; a line through the middle of the text is refused; sizes pass on only inside a group (design §7.5). Fire on that sheet went from four wrong sizes to one right one. |
| P4 | Competing against runs on every layer made things worse: the nearest "run" to a label is its own lettering. | Labels compete only among the groups in the command, and the skill measures every system at once. |
| P5 | Label boxes are padded, so a pipe correctly beside its label still enters the box. | "Beside" is the outer half of the box plus the reach, not clear space alone. |
| P6 | The scale bar is hatched lines, not filled boxes. | The bar is found by alternating ink between two equal edges, whatever draws the ink. |
| P7 | Hebrew stroke-font text decodes by key map, but the same sheet holds Latin labels (`l=15.90`, an e-mail address). | A label is decoded only when the result reads as Hebrew; the sheet as a whole decides whether to try. |
| P8 | The legend's sample lines are on the systems' own layers. | A `legend` command pairs captions with layers. It was not in the first design, and it removes most of the guessing about which layer is which. |
| P9 | Samples in the legend and title block add 2 to 4 m to each layer. | `--region` and `--exclude` on every measuring command. |
| P10 | A general PDF library was not needed: the files use a small part of the format. | An own reader of about 1,400 lines (design §4, option E). It reads a sheet in 0.1 to 0.3 seconds, against 2.3 for the prototype. |
| P11 | A fuzz run found a damaged file that never finished: a label box with an absurd coordinate made one loop walk that whole distance. | Strokes, fills and labels more than one sheet away from the sheet are dropped and counted; a label larger than the sheet is dropped; a page whose size is not usable is refused. A fixed fuzz test runs with the unit tests. |
| P12 | A worker following the Comis skill got every number right, but lost commands to gaps in the tool: a refused group name with no reason, no way to measure ink on no layer, no box for the legend, and settings that were only on stdout. | Nine fixes (design §6 and §7.6): a group name is the caller's words, `(no layer)` can be named, `legend` prints its box, `measure` says how many size labels found a run, and `--save` keeps the lines a workbook quotes. |

## 3. Build order

1. The PDF reader, with a test PDF writer that produces every file shape the reader claims to read.
2. Extraction to a `Sheet`, checked against the prototype's counts on real sheets (same strokes, fills and comments).
3. Label decoding, on real label text.
4. Scale, runs and sizes, each tuned on real sheets and then frozen in tests on a drawn sheet whose answers are chosen.
5. Commands and the AXI runtime.
6. Tests: unit, contract, AXI principles, on source and on the built package.
7. The live test and its private plan.
8. Documents, CI and release workflow.

## 4. Repository layout

```text
src/
  bin/drawing-axi.ts        entry: stdout only, exit code from main()
  cli/                      table.ts (command table), parse.ts (strict flags), run.ts (dispatch, help)
  commands/                 common.ts, home.ts, info.ts, layers.ts, labels.ts, measure.ts, symbols.ts
  drawing/                  model.ts, extract.ts, shx.ts, scale.ts, runs.ts, sizes.ts,
                            tags.ts, symbols.ts, legend.ts, svg.ts
  pdf/                      objects.ts (lexer), filters.ts, document.ts (xref, pages), fonts.ts
  output/                   toon.ts (bounds), text.ts (safety), views.ts (list, record)
  errors.ts, version.ts
test/
  fixtures/pdf.ts           a PDF writer for tests
  fixtures/sample.ts        the sample sheet and its known lengths
  unit/                     pdf, shx, drawing, version
  contract/                 commands, recipes: the CLI as a separate process
  axi/                      the ten principles
  live/                     drawing-live.mjs, plan.example.json; reports/ is gitignored
docs/                       design, this plan, master plan, recipes, releasing
scripts/                    clean, chmod-bin, check-package
```

Production code is about 6,300 lines, of which the reader is 1,400; tests and fixtures are about 2,800.

## 5. Module contracts

| Module | Takes | Gives | Never |
| --- | --- | --- | --- |
| `pdf/objects` | bytes | PDF objects; keywords for operators | throws on odd input except for nesting over 100 |
| `pdf/filters` | encoded bytes, a stream dictionary | decoded bytes, at most 256 MB | reads image filters |
| `pdf/document` | a file's bytes | resolved objects, decoded streams, pages with box, rotation and unit | reads an encrypted file |
| `pdf/fonts` | a font dictionary | text and advance of a shown string | renders glyphs |
| `drawing/extract` | a document and a page index | a `Sheet` in sheet coordinates | interprets what the lines mean |
| `drawing/shx` | labels | `text` filled in beside `raw` | changes `raw` |
| `drawing/scale` | a `Sheet`, optional ratio or factor | ratio, points per metre, basis, the bar | guesses a ratio |
| `drawing/runs` | strokes, a gap | runs with ends, length, and where ink lies | joins across a corner |
| `drawing/sizes` | grouped runs, size labels, a reach | runs with size and basis | sizes a run from a label under which it has ink |
| `drawing/tags`, `symbols`, `legend` | labels and strokes | tags, symbol groups, caption-to-layer pairs | names what a symbol or series means |
| `drawing/svg` | strokes, labels, a box | SVG text | copies anything but escaped text and numbers from the file |
| `commands/*` | parsed flags, `Io` | one TOON string | writes to stderr; reads any file but the one named |
| `output/*` | a document or rows | bounded, safe TOON | lets file text change the document's shape |

`Io` is `{ stdout, env, now, cwd }`. Tests run the real binary, so only the clock needs injecting.

## 6. Work breakdown

### 6.0 Progress, 2026-11-20

| Area | State |
| --- | --- |
| Reader, extraction, labels, scale, runs, sizes, tags, symbols, legend, picture | Done |
| Eleven commands and the AXI runtime | Done |
| Tests on source | 139 pass |
| Tests on the built package | 67 pass |
| Live gate on eight real sheets | 61 pass, 0 fail, 11 blocked (stages with no reference given) |
| Repository and CI | Done (T23) |
| Release | Done (T24, T25): 0.1.0 to 0.1.3 are on npm with signed provenance; the live gate passes on the installed package |
| Comis pack and skill | T26 to T29 done: merged as comisai/comis#4517. T30 done: the keyed live scenario passed on its third run (comisai/comis#4518) |

### M1: the reader

| Task | What | Done when |
| --- | --- | --- |
| T1 | Lexer and objects | Unit tests for every object kind, references, comments, deep nesting |
| T2 | Filters with predictors | Each filter decodes a known sample; an unknown filter is named |
| T3 | Cross-reference tables, streams, object streams, rebuild | The sample reads the same from six file shapes; a broken table is rebuilt for both kinds |
| T4 | Pages: inheritance, crop, rotation, user unit | Four rotations and a user unit give the same sheet |
| T5 | Refusals and bounds | Encrypted, not a PDF, a file cut short, a wrong stream length, content far outside the sheet, an unusable page size; a fixed set of 240 damaged files ends in a known error or a sheet |
| T6 | Test PDF writer | It produces every shape T3 to T5 need |

### M2: the sheet

| Task | What | Done when |
| --- | --- | --- |
| T7 | Extraction: paths, colours, layers, form XObjects, inline images, font text | Counts equal the prototype's on real sheets; unit tests on the sample |
| T8 | Comments as labels | Stroke-font comments and people's notes are told apart |
| T9 | Label decoding | Every rule of design §7.2 has a test, and the Latin labels that must not change |
| T10 | Scale | Bar found on the sample at 98%; a ruled table refused; flags override |
| T11 | Runs | Dashes joined; corners, dots, repeats and parallels handled |
| T12 | Sizes | Beside, in a break, through the text, neighbours inside a group only |
| T13 | Tags, symbols, legend | Exact counts on the sample; no legend where there is none |
| T14 | Picture | Well-formed SVG; file text escaped |

### M3: the tool

| Task | What | Done when |
| --- | --- | --- |
| T15 | Command table, strict parsing, help | Unknown, repeated and valueless flags refused |
| T16 | Commands | One contract test per command with exact rows |
| T17 | Errors | Every code reached by a test; no error echoes its input |
| T18 | Bounds, `--full`, `--save` | Default output within 4,000 characters; the saved JSON holds every run |
| T19 | Deadline | A past `COMIS_DEADLINE` gives `timed_out`; a bad one is a usage error |
| T20 | AXI principles | `test/axi` passes on source and on `dist` |
| T21 | Recipes | Every command in `docs/recipes.md` runs in a test |

### M4 and M5: qualification and release

| Task | What | Done when |
| --- | --- | --- |
| T22 | Live test and a private plan for real drawings | `npm run live` passes L1 to L9 with every length within 10% |
| T23 | Repository: public, protected `main`, CI on Node 22 and 24 | CI green on the first pull request |
| T24 | Release workflow and the `npm` environment | A `v0.1.0` tag publishes with provenance |
| T25 | Check the published package | `npm view drawing-axi dist.attestations` names this repository; the live test passes on the installed package |

### Comis pack (master plan M6 and M7)

| Task | What | Done when |
| --- | --- | --- |
| T26 | Decision record and docs | The Comis decision is merged |
| T27 | Publisher record and attestations fixture | `check:axi-publishers` passes with the pack's lock |
| T28 | Apps pack: lock, wrapper, doctor, NOTICE, inventory | The pack builds; the doctor finds the exact version |
| T29 | Skill `drawing-takeoff` | The skill tests pass; the skill filter offers it to main and reader workbenches |
| T30 | Proofs | A scripted stage with the pack installed, and a live scenario with a real model on a made-up sheet |

## 7. Test plan

| Tier | Runs | Needs |
| --- | --- | --- |
| `npm test` | Unit, contract and AXI tests on the TypeScript source | Nothing |
| `npm run test:dist` | Contract and AXI tests on `dist/` | `npm run build` |
| `node scripts/check-package.mjs` | What `npm publish` would ship | `npm run build` |
| `npm run live -- --plan <file>` | L1 to L9 on real drawings | A private plan file |

CI runs the first three on Node 22 and 24. It never runs the live test.

### 7.1 The live test

`test/live/drawing-live.mjs` runs the built CLI. Its plan file names, for each sheet: the file, boxes to exclude, the groups to measure, a person's length for each group, a person's length for some sizes, how many legend rows to expect, and texts the sheet must yield.

| Stage | Passes when |
| --- | --- |
| L1 opens | `info` exits 0 within 15 seconds |
| L2 scale | `scale` exits 0 |
| L3 legend | At least the expected rows pair with a layer |
| L4 labels | Every expected text is found |
| L5 lengths | Every group is within the tolerance (10%) of the reference |
| L6 sizes | No size is given to more pipe than the reference has, plus the size tolerance; the share sized is reported |
| L7 output | Every default output is one TOON document within the bound, with nothing on stderr |
| L8 repeat | The same command prints the same bytes twice |
| L9 picture | `render` writes well-formed SVG |

A stage with no expectation is `blocked`. `--strict` makes blocked stages fail, for a release gate on a complete plan.

**Rules.** The plan and the drawings stay outside the repository. Reports are gitignored, mode 0600, and name sheets by position. A pull request carries the summary line only.

### 7.2 Keeping the sample honest

The sample sheet is drawn from the facts in design §2. When a real drawing shows something new (a file shape, a label habit, a way of drawing a bar), the change adds it to `test/fixtures/` as a drawn case, and says in the pull request what the real file did. A real file is never added.

## 7.3 Findings for the next version

A fresh worker drafted a bill of quantities from a real level (a ceiling sheet and a floor sheet) with the released package and the Comis skill. It measured 2,290 m in 15 groups and listed every gap. Its notes are the work list for the next version. None is a wrong length; each is a place where the worker had to work round the tool.

| Area | Finding | Planned change |
| --- | --- | --- |
| Legend | A dashed sample and a sample drawn as a centre line with two side lines were missed or listed twice, and the box stopped short of them and of the fixture samples | Done in 0.1.2 for rows lost to rounding and indented samples (8–12 rows became 12–13 on one office's sheets). Open: one caption shown as two samples; the box round symbol rows |
| Legend | It names no layer for fixture samples | List symbol samples with their layer, as line samples are |
| Symbols | A symbol drawn as a fill alone is not counted; the same symbol has a different number of parts on two sheets | Count fills as symbols; add a match by place across two files |
| Sizes | `labels_apart` shows one label text for several different texts | Done in 0.1.1: one row per text |
| Sizes | A coded label written in a break of a line was kept for the group of its code, and the line came back unsized (found by the keyed live run) | Done in 0.1.1: a label in a break sizes its line |
| Sizes | Labels that found no run are counted but not listed | Done in 0.1.2: `unplaced` in the saved file |
| Sizes | A label with no system code, written between two parallel pipes of different systems, sizes one of them; one such label sized a neighbouring system's run | Report a label that fits two groups about equally as shared, and size neither |
| Tags | A number in the background's font text was paired with a size; single-letter tags are missed; the frame shape is not reported | Pair within one text source first; allow one-letter identifiers; report the frame |
| Tags | The help calls every tag a riser tag | Say "tag"; a tag at a pipe's end is not a riser |
| Runs | Runs under the minimum length are dropped without a total | Print the length left out |
| Layers | Layers with no ink are not named; `info` has no `--save` | `layers --all`; `info --save` |
| Picture | `render --labels` draws background font text at the size of its box | Cap the drawn text height |
| Text | Text drawn as outlines cannot be read | Out of reach for now; `info` should say when a sheet has it |
| Text | Some PDF fonts have missing or unusable character maps | Fixed in 0.1.4: use the font encoding to recover labels and report text that still cannot be decoded |

Three more workers took real levels from two offices in 0.1.1, blind to the people's bills. Their notes led to 0.1.2:

| Finding | Done in 0.1.2 |
| --- | --- |
| Linetype letters plotted as strokes joined into sparse lines beside the pipe (sprinklers 646 m, person 252 m) | Shadow runs left out and counted |
| Slope labels sized water, fire and pumped lines through their dash gaps | A coded group takes only its code's labels and sizes written alone |
| `OD7A` read as code `ODA` | The code is the letters before the first digit |
| The default reach placed 44 of 233 labels on one office's sheets | `measure` says how many a wider reach would place |
| Water dashes 8.5 mm apart read 35 to 55% short at the 8 mm gap | `gaps` names the group; `--group-gap` |
| A paving hatch taken for the scale bar: 102.4% instead of 98.7% | A bar in a field of the same ink is refused |
| Legend rows lost when the sample column was rounded two ways, an indented sample, and captions ending in a Latin code left undecoded | Fixed |
| Sizes written alone beside pipes could not be used without also using riser tags' sizes | `--plain` skips sizes a tag claims, and fixture labels |
| The saved file had no layers per group and no unplaced labels; cut tables did not say so | Added |

## 8. What is not in this plan

- Reading DWG or DXF.
- Pricing. The Comis skill hands rows to Priority; this tool does not know prices.
- Areas, volumes and counts of anything that is not a tag or a symbol.
- Vertical lengths, fittings, hangers and insulation: they are not on a plan.
- A cache between commands. A sheet reads in a fraction of a second.
