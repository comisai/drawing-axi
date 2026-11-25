import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AxiError } from '../errors.ts';

export const MAX_PNG_SIDE = 1568;
const MAX_RASTER_MS = 15_000;
const rasterizer = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? './rasterize.ts' : './rasterize.js',
    import.meta.url,
  ),
);

export function renderPng(
  svg: string,
  text: boolean,
  remainingMs: number,
): Buffer {
  const timeout = Math.min(MAX_RASTER_MS, remainingMs);
  const timedOut = () =>
    new AxiError(
      'timed_out',
      'The PNG took too long to draw. Choose fewer layers or a smaller --region.',
    );
  if (timeout <= 0) throw timedOut();
  // Kill a stalled native rasterizer even if it cannot handle a signal itself.
  const result = spawnSync(process.execPath, [rasterizer, text ? 'text' : ''], {
    input: svg,
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 12 * 1024 * 1024,
    windowsHide: true,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT')
    throw timedOut();
  if (result.error || result.status !== 0 || result.stdout.length === 0)
    throw new AxiError(
      'internal_error',
      'The PNG could not be drawn. Check that the PNG renderer is installed, or use --out with an .svg file.',
    );
  return result.stdout;
}
