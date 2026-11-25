# Contributing to drawing-axi

Thank you for helping. This guide covers how to set up the project, what a good change looks like, and how changes are reviewed.

## Before you start

- **Bugs:** open an [issue](https://github.com/comisai/drawing-axi/issues) with the command, its output and what you expected.
- **Features and larger changes:** open an issue first, so we can agree on the approach before you write code.
- **Security problems:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Real drawings:** a drawing belongs to the people who made it and the people who paid for it. Never attach one to an issue or a pull request, and never add one to tests or fixtures. Show the problem with a made-up sheet instead; `test/fixtures/pdf.ts` writes one in a few lines.

## Setup

You need Node.js 22.18 or later. Node runs the TypeScript sources directly, so tests need no build step.

```sh
git clone https://github.com/comisai/drawing-axi.git
cd drawing-axi
npm ci
npm run check       # type-check, lint, unit, contract and AXI-principle tests
npm run build       # dist/bin/drawing-axi.js
npm run test:dist   # contract and AXI-principle tests against the built CLI
```

`npm run format` formats the code with Biome.

## Project layout

| Path | What it holds |
| --- | --- |
| `src/pdf/` | The PDF reader: objects and the lexer, cross-reference tables and streams, object streams, stream filters, fonts |
| `src/drawing/` | What is read off a page: geometry by layer (`extract`), label decoding (`shx`), scale, runs, sizes, tags, symbols, the legend, and the SVG picture |
| `src/commands/` | The commands, and what they share (`common`) |
| `src/cli/` | Argument parsing, dispatch, and the command table that drives parsing, `--help` and usage lines |
| `src/output/` | TOON rendering, size bounds, text safety, and the list and record views |
| `test/fixtures/` | A PDF writer for tests, and the sample sheet with its known lengths |
| `test/unit/`, `test/contract/` | Unit tests, and tests of the CLI as a separate process against the sample sheet |
| `test/axi/` | The ten AXI principles, checked against the CLI |
| `test/live/` | The opt-in check against real drawings that stay outside the repository |
| `docs/` | Design, implementation plan, master plan, recipes and releasing |

## What a good change looks like

drawing-axi is used by AI agents, so its output is part of its interface. Follow these rules. `test/axi/principles.test.ts` checks most of them.
- **Output:** results go to stdout as TOON, starting with a summary line. Output stays within the size limits unless `--full` is given. Nothing goes to stderr.
- **Hints:** the `help[N]:` footer is a TOON list, one `- ` item per line, so the whole output decodes as one TOON document. `helpBlock` in `src/output/toon.ts` writes it. Each hint starts with ``Run `…` `` and names a command that exists.
- **Errors:** an error prints `message`, `code` and `usage` on stdout. The exit code is 1 for an error and 2 for a usage error. Reuse an existing code before adding a new one. A message never echoes the path, flag or value it was given.
- **Honest numbers:** a number is measured, or it is absent. Never fill in a size, a scale or a length the sheet does not state; report it as unsized or unknown, and say what would settle it. When a rule is a judgement (how far a label may sit from its run), make it a flag with a stated default, and print the setting with the result.
- **Files are untrusted.** Bound everything a file can make large: bytes, decoded bytes, nesting, coordinates, labels. Text from a file goes through the text-safety layer in `src/output/text.ts`. Write invisible or bidirectional characters in source as `\u` escapes, never as literal characters.
- **No network, no extra writes.** The tool reads the file it is given and writes only `--out`, `--save` and its sheet cache (`src/drawing/cache.ts`).
- **Dependencies:** the only runtime dependency is `@toon-format/toon`, pinned exactly. The PDF reader is this project's own code. Discuss any new dependency in an issue first.
- **Wording:** messages, help and docs use short, plain English sentences.

Add or update tests with every change. Tests start from a sheet whose answer is known: extend `test/fixtures/sample.ts` or draw a small sheet in the test with `test/fixtures/pdf.ts`, and state the expected number. When behaviour changes, update the README, the `--help` text and `docs/recipes.md`; if the Comis `drawing-takeoff` skill (in the Comis repository, `images/packs/apps/skills/drawing-takeoff/`) needs a change, say so in the pull request.

## Live tests

The live test runs the built CLI on real drawings and compares its lengths with a person's takeoff. The drawings and the reference numbers stay outside the repository, in a plan file you write:

```sh
cp test/live/plan.example.json ~/private/plan.json   # then point it at your drawings
npm run build
npm run live -- --plan ~/private/plan.json            # add --strict before a release
```

It prints a TOON summary and writes a report to `test/live/reports/` (gitignored, mode 0600). The report names sheets by position and holds layer names and numbers, not drawings. Attach only the summary line to a pull request, and only if the drawings' owner allows it.

Run it before each release, and whenever a change touches `src/pdf/`, `src/drawing/extract.ts`, `runs.ts`, `sizes.ts` or `scale.ts`. A change that moves a live length by more than a percent says so in the pull request, with the reason.

Continuous integration never runs the live test.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request to one topic.
3. Run `npm run check`, `npm run build` and `npm run test:dist`. Continuous integration runs the same checks on Node 22 and 24.
4. Fill in the pull request template: what changed, why, and how you tested it.

`main` is protected. Every change goes through a pull request whose checks pass, and a maintainer squash-merges it. Maintainers release by following [docs/releasing.md](docs/releasing.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
