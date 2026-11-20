// Every drawing-axi command in docs/recipes.md runs against the sample sheet
// and succeeds, so the recipes cannot drift from the tool.

import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { before, it } from 'node:test';
import { body, fixtureFolder, runBinary } from '../helpers.ts';

/** Split a shell line into arguments: spaces, with single quotes kept whole. */
function words(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line))
    out.push(m[1] ?? (m[2] as string));
  return out;
}

const recipes = readFileSync(
  new URL('../../docs/recipes.md', import.meta.url),
  'utf8',
);
const commands: string[][] = [];
for (const block of recipes.matchAll(/```sh\n([\s\S]*?)```/g)) {
  const joined = (block[1] as string).replace(/\\\n\s*/g, ' ');
  for (const line of joined.split('\n')) {
    const text = line.replace(/\s+#.*$/, '').trim();
    if (text.startsWith('drawing-axi')) commands.push(words(text).slice(1));
  }
}

let dir: string;
before(() => {
  dir = realpathSync(fixtureFolder());
});

it('finds the recipes', () => {
  assert.ok(commands.length >= 15, `${commands.length} commands`);
});

it('every recipe command succeeds on the sample sheet', async () => {
  for (const args of commands) {
    const r = await runBinary(args, dir);
    assert.equal(r.code, 0, `drawing-axi ${args.join(' ')}: ${r.stdout}`);
    assert.equal(r.stderr, '', args.join(' '));
    assert.doesNotThrow(() => body(r.stdout), args.join(' '));
  }
});

it('the boxed legend recipe finds the legend', async () => {
  const boxed = commands.find(
    (c) => c[0] === 'legend' && c.includes('--region'),
  );
  assert.ok(boxed);
  const doc = body((await runBinary(boxed, dir)).stdout);
  assert.equal((doc.legend as unknown[]).length, 4);
});
