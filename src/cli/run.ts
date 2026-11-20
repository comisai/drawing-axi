// Dispatch: home view with no command, help and version, then one command.
// Everything goes to stdout. Exit codes: 0 ok, 1 error, 2 usage.

import { encode } from '@toon-format/toon';
import {
  AREA_FLAGS,
  FULL_FLAG,
  LIMIT_FLAG,
  PAGE_FLAG,
  readerError,
  SAVE_FLAG,
  SCALE_FLAGS,
} from '../commands/common.ts';
import { DESCRIPTION, home } from '../commands/home.ts';
import { info, scale } from '../commands/info.ts';
import { labels, legend, tags } from '../commands/labels.ts';
import { layers } from '../commands/layers.ts';
import { measure, runs } from '../commands/measure.ts';
import { renderCommand, symbols } from '../commands/symbols.ts';
import { AxiError, usage } from '../errors.ts';
import { errorText, helpBlock } from '../output/toon.ts';
import { VERSION } from '../version.ts';
import { parseCommand } from './parse.ts';
import {
  BIN,
  type CommandSpec,
  commandName,
  type FlagSpec,
  type Io,
  usageLine,
} from './table.ts';

const FILE = [{ name: '<file.pdf>', required: true }];
const GAP: FlagSpec = {
  type: 'string',
  value: '<mm>',
  summary: 'Join pieces up to this far apart on paper, default 8',
};
const MIN: FlagSpec = {
  type: 'string',
  value: '<mm>',
  summary: 'Leave out runs shorter than this on paper, default 6',
};
const LAYER: FlagSpec = {
  type: 'string',
  multiple: true,
  value: '<layer>',
  summary: 'A layer by name; LAYER@#rrggbb takes one colour of it',
};
const GROUP: FlagSpec = {
  type: 'string',
  multiple: true,
  value: '<name>=<layer>',
  summary: 'Layers measured as one system, joined by +: sewer=SEWER+VENT',
};
const MATCH: FlagSpec = {
  type: 'string',
  value: '<regex>',
  summary: 'Only labels whose text matches, ignoring case',
};
const SOURCE: FlagSpec = {
  type: 'string',
  value: '<kind>',
  summary: 'shx (stroke-font text), text (font text), note (comments) or all',
};
const EACH: FlagSpec = {
  type: 'boolean',
  summary: 'One row per item with its place, instead of counts',
};

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: '',
    args: [],
    flags: {},
    summary: 'Home view: the PDF drawings in this folder',
    run: home,
  },
  {
    name: 'info',
    args: FILE,
    flags: { page: PAGE_FLAG, ...SCALE_FLAGS, full: FULL_FLAG },
    summary:
      'What a sheet holds: size, scale, layers, labels, and what is missing',
    run: info,
  },
  {
    name: 'scale',
    args: FILE,
    flags: { page: PAGE_FLAG, ...SCALE_FLAGS, save: SAVE_FLAG },
    summary: "The sheet's scale and how it was found",
    run: scale,
  },
  {
    name: 'layers',
    args: FILE,
    flags: {
      match: {
        type: 'string',
        value: '<text>',
        summary: 'Only layers whose name contains this',
      },
      split: {
        type: 'boolean',
        summary: 'One row per colour of each layer',
      },
      gap: GAP,
      min: MIN,
      ...AREA_FLAGS,
      ...SCALE_FLAGS,
      page: PAGE_FLAG,
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
    },
    summary: 'Layers with the length of straight runs drawn on each',
    run: layers,
  },
  {
    name: 'legend',
    args: FILE,
    flags: {
      source: SOURCE,
      ...AREA_FLAGS,
      page: PAGE_FLAG,
      limit: { ...LIMIT_FLAG, summary: 'Rows to show, default 40' },
      full: FULL_FLAG,
      save: SAVE_FLAG,
    },
    summary: 'Legend lines paired with the layer and colour of their samples',
    run: legend,
  },
  {
    name: 'labels',
    args: FILE,
    flags: {
      match: MATCH,
      source: SOURCE,
      each: EACH,
      sizes: {
        type: 'boolean',
        summary: 'The pipe sizes the labels name, with counts',
      },
      ...AREA_FLAGS,
      page: PAGE_FLAG,
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
    },
    summary: 'The text on the sheet: legend, notes, sizes, tags',
    run: labels,
  },
  {
    name: 'tags',
    args: FILE,
    flags: {
      match: MATCH,
      source: SOURCE,
      each: EACH,
      ...AREA_FLAGS,
      page: PAGE_FLAG,
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
    },
    summary: 'Riser tags with the size written beside each, counted by series',
    run: tags,
  },
  {
    name: 'runs',
    args: FILE,
    flags: {
      layer: LAYER,
      group: GROUP,
      gap: GAP,
      min: MIN,
      ...AREA_FLAGS,
      ...SCALE_FLAGS,
      page: PAGE_FLAG,
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
    },
    summary:
      'The straight runs on chosen layers, each with its length and ends',
    run: runs,
  },
  {
    name: 'measure',
    args: FILE,
    flags: {
      group: GROUP,
      layer: LAYER,
      gap: GAP,
      min: MIN,
      reach: {
        type: 'string',
        value: '<mm>',
        summary:
          'A size label may sit this far from its run on paper, default 1.5',
      },
      plain: {
        type: 'boolean',
        summary:
          'Also use sizes written alone, without a slope or system prefix',
      },
      ...AREA_FLAGS,
      ...SCALE_FLAGS,
      page: PAGE_FLAG,
      limit: { ...LIMIT_FLAG, summary: 'Size rows to show, default 40' },
      full: FULL_FLAG,
      save: SAVE_FLAG,
    },
    summary:
      'Run length by group and pipe size: the table for a bill of quantities',
    run: measure,
  },
  {
    name: 'symbols',
    args: FILE,
    flags: {
      layer: { ...LAYER, required: true },
      join: {
        type: 'string',
        value: '<mm>',
        summary: 'Pieces this close on paper are one symbol, default 1.5',
      },
      'max-piece': {
        type: 'string',
        value: '<mm>',
        summary: 'Pieces larger than this on paper are lines, default 30',
      },
      ...AREA_FLAGS,
      ...SCALE_FLAGS,
      page: PAGE_FLAG,
      limit: LIMIT_FLAG,
      full: FULL_FLAG,
      save: SAVE_FLAG,
    },
    summary: 'Symbols on chosen layers, counted by size and make-up',
    run: symbols,
  },
  {
    name: 'render',
    args: FILE,
    flags: {
      out: {
        type: 'string',
        required: true,
        value: '<file.svg>',
        summary: 'The picture to write',
      },
      layer: LAYER,
      region: AREA_FLAGS.region,
      labels: { type: 'boolean', summary: 'Draw the labels too' },
      grid: {
        type: 'boolean',
        summary: 'Draw a coordinate grid, in points from the top-left corner',
      },
      width: {
        type: 'string',
        value: '<px>',
        summary: 'Picture width in pixels, default 1600',
      },
      force: {
        type: 'boolean',
        summary: 'Replace the --out file if it exists',
      },
      page: PAGE_FLAG,
    },
    summary: 'Write a picture of chosen layers and area as SVG, to look at',
    run: renderCommand,
  },
  {
    name: 'help',
    args: [{ name: '<command>', required: false }],
    flags: {},
    summary: 'Show help for a command',
    run: async () => '',
  },
];

const HOME = COMMANDS[0] as CommandSpec;
const HELP_FLAGS = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-v', '-V']);

export function topHelp(): string {
  return `${encode({
    description: DESCRIPTION,
    usage: `${BIN} [command] [flags]`,
    commands: COMMANDS.map((c) => ({
      command: commandName(c),
      summary: c.summary,
    })),
    positions:
      'x,y in points from the top-left corner of the sheet, x right and y down; 72 points are one inch on paper',
    settings:
      'COMIS_DEADLINE (epoch ms): stop reading and say so before this time',
  })}\n${helpBlock([`Run \`${BIN} help <command>\` for its flags`])}`;
}

export function commandHelp(spec: CommandSpec): string {
  const flags = Object.entries(spec.flags).map(([name, f]) => ({
    flag:
      f.type === 'string' ? `--${name} ${f.value ?? '<value>'}` : `--${name}`,
    summary: f.multiple ? `${f.summary} (repeatable)` : f.summary,
  }));
  return `${encode({
    command: commandName(spec),
    summary: spec.summary,
    usage: usageLine(spec),
    ...(flags.length ? { flags } : {}),
  })}\n`;
}

function find(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name && c.name !== '');
}

function unknownCommand(name: string): AxiError {
  const shown = /^[a-z][a-z-]{0,30}$/.test(name)
    ? `\`${name}\``
    : 'that command';
  const list = COMMANDS.filter((c) => c.name).map((c) => c.name);
  return usage(`Unknown command ${shown}. Commands: ${list.join(', ')}.`);
}

export async function main(argv: string[], io: Io): Promise<number> {
  let spec: CommandSpec = HOME;
  let usageText = `${BIN} [command] [flags]`;
  try {
    const first = argv[0];
    if (argv.length === 1 && first && VERSION_FLAGS.has(first)) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (argv.length === 1 && first && HELP_FLAGS.has(first)) {
      io.stdout(topHelp());
      return 0;
    }
    let rest = argv;
    if (first && !first.startsWith('-')) {
      const found = find(first);
      if (!found) throw unknownCommand(first);
      spec = found;
      rest = argv.slice(1);
    }
    usageText = usageLine(spec);
    const beforeTerminator = rest.includes('--')
      ? rest.slice(0, rest.indexOf('--'))
      : rest;
    if (beforeTerminator.some((a) => HELP_FLAGS.has(a))) {
      io.stdout(commandHelp(spec));
      return 0;
    }
    const parsed = parseCommand(spec, rest);
    if (spec.name === 'help') {
      const target = parsed.positionals[0];
      if (!target) {
        io.stdout(topHelp());
        return 0;
      }
      const found = find(target);
      if (!found) throw unknownCommand(target);
      io.stdout(commandHelp(found));
      return 0;
    }
    io.stdout(await spec.run({ ...parsed, io }));
    return 0;
  } catch (thrown) {
    const error = readerError(thrown);
    const axi =
      error instanceof AxiError
        ? error
        : new AxiError(
            'internal_error',
            'drawing-axi failed unexpectedly. Run the command once more; if it fails again, report it.',
          );
    io.stdout(errorText(axi, usageText));
    return axi.exitCode;
  }
}
