// The ten AXI principles (axi.md, and the stricter Comis reading), checked
// against the real binary as a separate process. Set DRAWING_AXI_BIN=dist to
// check the built package instead of the source.

import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { COMMANDS } from '../../src/cli/run.ts';
import { FULL_LIMIT, OUTPUT_LIMIT } from '../../src/output/toon.ts';
import { PLAN } from '../fixtures/sample.ts';
import { body, fixtureFolder, rowsOf, runBinary } from '../helpers.ts';

let dir: string;
const run = (...args: string[]) => runBinary(args, dir);

before(() => {
  dir = realpathSync(fixtureFolder());
});

/** The help footer's hints: a TOON list at the end, one `- ` item per line. */
function helpLines(text: string): string[] {
  const m = /^help\[(\d+)\]:\n((?: {2}- .*\n)*)$/m.exec(text);
  if (!m) {
    assert.doesNotMatch(text, /^help\[/m, 'a help footer is a TOON list');
    return [];
  }
  const raw = (m[2] ?? '').split('\n').filter(Boolean);
  assert.equal(raw.length, Number(m[1]), 'help[n] counts its lines');
  const hints = body(text).help;
  assert.ok(Array.isArray(hints), 'help decodes as a list');
  assert.equal(hints.length, raw.length);
  return hints.map(String);
}

const LISTS: Array<[string, string[]]> = [
  ['layers', ['layers', 'plan.pdf']],
  ['layers', ['layers', 'plan.pdf', '--split']],
  ['legend', ['legend', 'plan.pdf']],
  ['labels', ['labels', 'plan.pdf']],
  ['labels', ['labels', 'plan.pdf', '--each']],
  ['sizes', ['labels', 'plan.pdf', '--sizes']],
  ['tags', ['tags', 'plan.pdf']],
  ['tags', ['tags', 'plan.pdf', '--each']],
  ['runs', ['runs', 'plan.pdf', '--layer', 'SEWER']],
  ['sizes', ['measure', 'plan.pdf', '--layer', 'SEWER', '--layer', 'RAIN']],
  ['groups', ['measure', 'plan.pdf', '--layer', 'SEWER', '--layer', 'RAIN']],
  ['symbols', ['symbols', 'plan.pdf', '--layer', 'SYMBOLS']],
];
const RECORDS: string[][] = [
  ['info', 'plan.pdf'],
  ['scale', 'plan.pdf'],
  ['render', 'plan.pdf', '--out', 'p.svg', '--force'],
];
const ERRORS: string[][] = [
  ['info', 'missing.pdf'],
  ['info'],
  ['layers', 'plan.pdf', '--bogus'],
  ['frobnicate'],
  ['measure', 'plan.pdf', '--layer', 'NOPE'],
  ['layers', 'locked.pdf'],
];

describe('AXI principles', () => {
  it('1. output is TOON from the official encoder, on stdout only', async () => {
    for (const args of [[], ...LISTS.map((l) => l[1]), ...RECORDS]) {
      const r = await run(...args);
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.stderr, '', args.join(' '));
      assert.doesNotThrow(() => body(r.stdout), args.join(' '));
    }
  });

  it('1b. every output decodes as one TOON document: lists, help, usage and errors', async () => {
    const outputs: Array<[string, string]> = [];
    for (const args of [
      [],
      ['--help'],
      ['help'],
      ...COMMANDS.filter((c) => c.name).map((c) => [c.name, '--help']),
      ...COMMANDS.filter((c) => c.name).map((c) => ['help', c.name]),
      ...LISTS.map((l) => l[1]),
      ...RECORDS,
      ...ERRORS,
    ]) {
      const r = await run(...args);
      assert.equal(r.stderr, '', args.join(' '));
      outputs.push([args.join(' ') || '(home)', r.stdout]);
    }
    let footers = 0;
    for (const [what, text] of outputs) {
      let doc: Record<string, unknown> = {};
      assert.doesNotThrow(() => {
        doc = body(text);
      }, what);
      assert.ok(text.endsWith('\n'), `${what} ends with a newline`);
      if (/^help\[/m.test(text)) {
        footers++;
        assert.deepEqual(doc.help, helpLines(text), what);
      }
    }
    assert.ok(footers >= LISTS.length, `${footers} help footers`);
  });

  it('2. list rows carry three to five fields by default', async () => {
    for (const [key, args] of LISTS) {
      const rows = rowsOf(body((await run(...args)).stdout), key);
      assert.ok(rows.length > 0, args.join(' '));
      for (const row of rows) {
        const n = Object.keys(row).length;
        assert.ok(n >= 3 && n <= 5, `${args.join(' ')}: ${n} fields`);
      }
    }
  });

  it('3. long text is cut with its size and a --full hint', async () => {
    const r = await run('labels', 'plan.pdf', '--source', 'note');
    assert.match(
      r.stdout,
      / … \(truncated, \d+ code points total; use --full to see all\)/,
    );
    const full = await run('labels', 'plan.pdf', '--source', 'note', '--full');
    assert.doesNotMatch(full.stdout, /truncated/);
  });

  it('4. a list says how many rows it shows and how many there are', async () => {
    const two = body((await run('layers', 'plan.pdf', '--limit', '2')).stdout);
    assert.match(String(two.summary), /^2 of 9 layers with ink/);
    assert.equal(rowsOf(two, 'layers').length, 2);
    const all = body((await run('layers', 'plan.pdf')).stdout);
    assert.match(String(all.summary), /^9 layers with ink/);
    const runs = body(
      (await run('runs', 'plan.pdf', '--layer', 'SEWER', '--limit', '1'))
        .stdout,
    );
    assert.match(String(runs.summary), /^1 of 5 runs, /);
  });

  it('5. an empty answer says so, and says what to try', async () => {
    for (const [args, summary] of [
      [['labels', 'plan.pdf', '--match', 'zzzz'], /^0 labels match$/],
      [
        ['layers', 'plan.pdf', '--match', 'zzzz'],
        /^0 layers match; the sheet has 9$/,
      ],
      [['tags', 'plan.pdf', '--region', '0,0,50,50'], /^0 tags with a size/],
      [
        ['symbols', 'plan.pdf', '--layer', 'RAIN', '--region', '0,0,50,50'],
        /^0 symbols/,
      ],
      [['runs', 'plan.pdf', '--layer', 'SYMBOLS'], /^0 runs/],
      [
        ['legend', 'plan.pdf', '--region', '0,0,50,50'],
        /^0 legend lines found/,
      ],
    ] as const) {
      const r = await run(...args);
      assert.equal(r.code, 0, args.join(' '));
      const doc = body(r.stdout);
      assert.match(String(doc.summary), summary, args.join(' '));
      assert.ok(helpLines(r.stdout).length >= 1, args.join(' '));
    }
  });

  it('6. errors are records on stdout with exit code 1, or 2 for usage', async () => {
    for (const args of ERRORS) {
      const r = await run(...args);
      const doc = body(r.stdout);
      assert.equal(r.stderr, '', args.join(' '));
      assert.deepEqual(Object.keys(doc).slice(0, 3), [
        'message',
        'code',
        'usage',
      ]);
      assert.equal(r.code, doc.code === 'usage' ? 2 : 1, args.join(' '));
      assert.match(String(doc.message), /\.$/, 'a message is a sentence');
    }
  });

  it('6b. an error never echoes what it was given', async () => {
    const secret = 'sk-test-0123456789abcdefXYZ';
    for (const args of [
      ['info', `/tmp/${secret}.pdf`],
      ['layers', 'plan.pdf', `--${secret}`],
      ['measure', 'plan.pdf', '--layer', `${secret} `],
      ['labels', 'plan.pdf', '--match', `(${secret}`],
      [secret],
    ]) {
      const r = await run(...args);
      assert.notEqual(r.code, 0, args.join(' '));
      assert.ok(!r.stdout.includes(secret), args.join(' '));
    }
  });

  it('7. with no arguments it shows live state, not help', async () => {
    const doc = body((await run()).stdout);
    assert.equal(typeof doc.bin, 'string');
    assert.equal(typeof doc.description, 'string');
    // The test runs with HOME set to the folder, so it is shown as home.
    assert.equal(doc.folder, '~');
    assert.equal(rowsOf(doc, 'drawings').length, 6);
    assert.equal(doc.commands, undefined);
  });

  it('8. hints are whole commands that exist', async () => {
    const names = new Set(COMMANDS.map((c) => c.name).filter(Boolean));
    let seen = 0;
    for (const args of [[], ...LISTS.map((l) => l[1]), ...RECORDS]) {
      const r = await run(...args);
      const hints = helpLines(r.stdout);
      assert.ok(
        hints.length >= 1 && hints.length <= 3,
        `${args.join(' ')}: ${hints.length} hints`,
      );
      for (const hint of hints) {
        seen++;
        const m = /^Run `([a-z-]+)(?: ([a-z-]+))?[^`]*`/.exec(hint);
        assert.ok(m, hint);
        if (m[1] === 'drawing-axi') assert.ok(names.has(m[2] ?? ''), hint);
      }
    }
    assert.ok(seen > 20);
  });

  it('9. help is short, and every command has its own', async () => {
    const top = await run('--help');
    assert.equal(top.code, 0);
    const doc = body(top.stdout);
    const listed = rowsOf(doc, 'commands').map((c) => c.command);
    assert.deepEqual(
      listed,
      COMMANDS.map((c) => (c.name ? `drawing-axi ${c.name}` : 'drawing-axi')),
    );
    assert.ok(top.stdout.length < 2000, `${top.stdout.length} characters`);
    for (const command of COMMANDS.filter((c) => c.name)) {
      const r = await run(command.name, '--help');
      assert.equal(r.code, 0, command.name);
      const help = body(r.stdout);
      assert.equal(help.command, `drawing-axi ${command.name}`);
      assert.match(
        String(help.usage),
        new RegExp(`^drawing-axi ${command.name}`),
      );
      assert.ok(r.stdout.length < 2600, `${command.name}: ${r.stdout.length}`);
      assert.deepEqual(
        body((await run('help', command.name)).stdout),
        help,
        command.name,
      );
    }
  });

  it('10. default output is bounded, and --full is bounded higher', async () => {
    for (const args of [
      [],
      ['info', 'plan.pdf'],
      ['layers', 'plan.pdf', '--limit', '999'],
      ['labels', 'plan.pdf', '--limit', '999'],
      ['labels', 'plan.pdf', '--each', '--limit', '999'],
      [
        'runs',
        'plan.pdf',
        '--layer',
        'TEXT',
        '--layer',
        'SEWER',
        '--limit',
        '999',
      ],
      [
        'measure',
        'plan.pdf',
        '--layer',
        'SEWER',
        '--layer',
        'RAIN',
        '--region',
        PLAN,
      ],
    ]) {
      const r = await run(...args);
      assert.equal(r.code, 0, args.join(' '));
      assert.ok(
        r.stdout.length <= OUTPUT_LIMIT,
        `${args.join(' ')}: ${r.stdout.length} characters`,
      );
    }
    const full = await run(
      'labels',
      'plan.pdf',
      '--each',
      '--full',
      '--source',
      'all',
    );
    assert.equal(full.code, 0);
    assert.ok(Buffer.byteLength(full.stdout) <= FULL_LIMIT);
    assert.equal(rowsOf(body(full.stdout), 'labels').length, 26);
  });

  it('text from the file cannot hide or reorder output', async () => {
    // Layer and label text is data: control and bidirectional-override
    // characters are shown as escapes.
    const { visibleString } = await import('../../src/output/text.ts');
    assert.equal(visibleString('a\u202eb'), 'a\\u202eb');
    assert.equal(visibleString('a\u0007b\u200bc'), 'a\\u0007b\\u200bc');
    assert.equal(
      visibleString('\u05e6\u05e0\u05e8\u05ea'),
      '\u05e6\u05e0\u05e8\u05ea',
    );
  });
});
