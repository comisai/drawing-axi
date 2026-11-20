#!/usr/bin/env node
import { main } from '../cli/run.ts';

// A reader that closes early, as in `drawing-axi ... | head`, is a normal end.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const code = await main(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text);
  },
  env: process.env,
  now: () => new Date(),
  cwd: process.cwd(),
});

// Never end stdout: it may be a socket the caller's shell also writes to, and
// ending a socket shuts down writing for every process that shares it. An
// empty write's callback runs only after every earlier write has flushed.
process.stdout.write('', () => process.exit(code));
