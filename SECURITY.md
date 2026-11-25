# Security Policy

drawing-axi reads files that come from other people. A drawing can be damaged or made on purpose to break a reader, and its text is shown to an AI agent, so we take security reports seriously.

## Supported versions

Security fixes go to `main` and to the next `0.x` release on npm. Only the latest release is supported.

## Reporting a vulnerability

Do not open a public issue. Report it privately through GitHub:
1. Go to the [Security tab](https://github.com/comisai/drawing-axi/security/advisories/new).
2. Choose **Report a vulnerability**.

Include:
- what the problem is, and what an attacker could do with it;
- the commit or version affected;
- the steps to reproduce it, ideally with a small file built by `test/fixtures/pdf.ts`.

Never include a real drawing that is not yours to share. The maintainers will acknowledge your report, keep you informed while they work on a fix, and agree on the disclosure with you.

## Scope

**In scope:**
- A file that makes the tool hang, run out of memory, or run past `COMIS_DEADLINE` without stopping.
- A file that makes the tool read or write any path other than the file named, `--out`, `--save` and an entry of its sheet cache.
- A way to make the tool use a cache entry written by another user, or a sheet kept for different file content.
- Any network connection.
- A bypass of the text-safety layer: invisible or bidirectional characters from a file's layer names or labels passing through unescaped, or text from a file changing the shape of the output so that it no longer decodes as one TOON document.
- An error message that echoes a path, flag or value it was given.
- `render` writing something other than well-formed SVG, or carrying script or external references from the file into it.

**Out of scope:**
- A wrong length, size or count on a drawing. That is a bug: open an issue, with a made-up file that shows it.
- Vulnerabilities in Comis; report those to the Comis maintainers.
