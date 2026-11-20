// Text that CAD programs draw with stroke (SHX) fonts is kept in the PDF as
// the characters the drafter's font was fed, not as what the sheet shows:
// - `%%C`, `%%D` and `%%P` stand for the diameter, degree and plus-minus signs;
// - a Hebrew stroke font takes the Latin keys of the Israeli keyboard, and
//   draws right to left, so digits and Latin letters inside it are stored
//   back to front;
// - older fonts take DOS Hebrew bytes, which reach the PDF as Windows-1252
//   punctuation, in the order they appear on the sheet.
// Each rule is applied only where the result reads as Hebrew; anything else
// is left as stored.

import type { Label } from './model.ts';

const KEYS = "qwertyuiopasdfghjkl;'zxcvbnm,./";
const HEBREW =
  "/'\u05e7\u05e8\u05d0\u05d8\u05d5\u05df\u05dd\u05e4\u05e9\u05d3\u05d2\u05db\u05e2\u05d9\u05d7\u05dc\u05da\u05e3,\u05d6\u05e1\u05d1\u05d4\u05e0\u05de\u05e6\u05ea\u05e5.";
const KEY_MAP = new Map<string, string>();
[...KEYS].forEach((k, i) => {
  KEY_MAP.set(k, [...HEBREW][i] as string);
});

const FINALS = new Set('\u05da\u05dd\u05df\u05e3\u05e5');
const isHebrew = (c: string | undefined): boolean =>
  c !== undefined && c >= '\u05d0' && c <= '\u05ea';
const isRtl = (c: string | undefined): boolean =>
  c !== undefined && c >= '\u0590' && c <= '\u08ff';
const isLatin = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z0-9]/.test(c);
const JOINERS = new Set('.,/\\:"\'%=+-_xX\u00d8\u00d7\u00b0\u00b1#&*');
const MIRROR: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '<': '>',
  '>': '<',
  '{': '}',
  '}': '{',
};

/** `%%C`, `%%D`, `%%P`, `%%U`, `%%O`, `%%%` and `%%nnn`. */
export function controlCodes(raw: string): string {
  return raw.replace(/%%(\d{3}|[A-Za-z%])/g, (all, code: string) => {
    switch (code.toLowerCase()) {
      case 'c':
        return '\u00d8';
      case 'd':
        return '\u00b0';
      case 'p':
        return '\u00b1';
      case 'u':
      case 'o':
      case 'k':
        return '';
      case '%':
        return '%';
      default: {
        const n = Number(code);
        return Number.isInteger(n) && n >= 32 ? String.fromCharCode(n) : all;
      }
    }
  });
}

/**
 * Put digits and Latin letters inside right-to-left text back in reading
 * order, and turn brackets the way they face on the sheet.
 */
function orderRuns(chars: string[]): string[] {
  const out = [...chars];
  const inRun = new Array<boolean>(out.length).fill(false);
  let i = 0;
  while (i < out.length) {
    if (!isLatin(out[i])) {
      i++;
      continue;
    }
    let end = i;
    for (let j = i + 1; j < out.length; j++) {
      const c = out[j] as string;
      if (isLatin(c)) end = j;
      else if (!JOINERS.has(c)) break;
    }
    let start = i;
    // An inch or foot mark stored before a number follows it on the sheet.
    if (
      (out[start - 1] === '"' || out[start - 1] === "'") &&
      !isHebrew(out[start - 2])
    )
      start--;
    const run = out.slice(start, end + 1).reverse();
    for (let k = 0; k < run.length; k++) {
      out[start + k] = run[k] as string;
      inRun[start + k] = true;
    }
    i = end + 1;
  }
  return out.map((c, k) => (inRun[k] ? c : (MIRROR[c] ?? c)));
}

/** Text stored in the order it appears, left to right, as most PDFs do. */
export function visualToLogical(text: string): string {
  const chars = [...text];
  if (!chars.some(isRtl)) return text;
  return orderRuns(chars.reverse()).join('');
}

function keyed(text: string): string {
  return [...text].map((c) => KEY_MAP.get(c) ?? c).join('');
}

/** Whether keyboard-mapped text reads as Hebrew. */
function plausibleHebrew(mapped: string): boolean {
  if (/[@~^`|]|:\/\//.test(mapped)) return false;
  const chars = [...mapped];
  let letters = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (!isHebrew(c)) continue;
    letters++;
    // A final letter ends a word and never stands alone.
    if (FINALS.has(c) && (!isHebrew(chars[i - 1]) || isHebrew(chars[i + 1])))
      return false;
    // One letter between digits is a Latin x or similar, not a word.
    if (/\d/.test(chars[i - 1] ?? '') && /\d/.test(chars[i + 1] ?? ''))
      return false;
  }
  if (letters >= 2) return true;
  return letters === 1 && /[\u05d0-\u05ea]['".]/.test(mapped);
}

// Windows-1252 code points for bytes 0x80 to 0x9A (0 where it has none). DOS
// Hebrew puts alef to tav on those bytes.
const CP1252_HIGH_POINTS = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0, 0x017d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d,
  0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161,
];
const CP1252_HIGH = new Map<string, number>();
CP1252_HIGH_POINTS.forEach((point, index) => {
  if (point) CP1252_HIGH.set(String.fromCharCode(point), 0x80 + index);
});

function dosHebrew(text: string): string | null {
  const chars = [...text];
  let mapped = 0;
  let others = 0;
  const out = chars.map((c) => {
    const byte = CP1252_HIGH.get(c);
    if (byte !== undefined) {
      mapped++;
      return String.fromCharCode(0x05d0 + byte - 0x80);
    }
    if (/[A-Za-z]/.test(c)) others++;
    return c;
  });
  if (mapped < 3 || others > mapped) return null;
  return orderRuns(out.reverse()).join('');
}

/** Fill in `text` for stroke-font comments; other labels keep their raw text. */
export function decodeLabels(labels: Label[]): void {
  const cleaned = labels.map((l) =>
    l.source === 'shx' ? controlCodes(l.raw) : l.raw,
  );
  // Does this drawing use a keyboard-mapped Hebrew font at all? Latin words
  // rarely survive the mapping, so the longer labels decide.
  let samples = 0;
  let plausible = 0;
  labels.forEach((l, i) => {
    const s = cleaned[i] as string;
    if (l.source !== 'shx' || (s.match(/[a-z]/g)?.length ?? 0) < 4) return;
    samples++;
    if (plausibleHebrew(keyed(s))) plausible++;
  });
  const hebrewKeys = samples >= 3 && plausible / samples >= 0.6;
  labels.forEach((l, i) => {
    const s = cleaned[i] as string;
    if (l.source !== 'shx') {
      l.text = s.trim();
      return;
    }
    const dos = dosHebrew(s);
    if (dos !== null) {
      l.text = dos.trim();
      return;
    }
    if (hebrewKeys && /[a-z]/.test(s)) {
      const mapped = keyed(s);
      if (plausibleHebrew(mapped)) {
        l.text = orderRuns([...mapped])
          .join('')
          .replace(/(?<=[\u05d0-\u05ea])''(?=[\u05d0-\u05ea])/g, '"')
          .trim();
        return;
      }
    }
    // Latin text fed to a right-to-left font: brackets give it away.
    if (/^\)[^()]*\($/.test(s.trim())) {
      l.text = [...s.trim()].reverse().join('');
      return;
    }
    l.text = s.trim();
  });
}
