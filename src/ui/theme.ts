/**
 * infinity-harness — terminal styling primitives.
 *
 * Two things every renderer here needs and neither the host nor Node gives us:
 *
 *   1. Width that matches what the terminal actually draws. An ANSI escape
 *      occupies zero columns and a CJK glyph occupies two, so every layout
 *      decision measures with `width()` rather than `String.length`.
 *   2. Colour that degrades. A pipe, a CI log, and NO_COLOR all want plain
 *      text; a modern terminal wants truecolor. `createStyler` picks once.
 */

import stringWidth from "string-width";

const ESC = "\u001b";
const RESET = ESC + "[0m";
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Display width in terminal columns, ignoring ANSI and honouring wide chars. */
export function width(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) w += cellWidth(ch);
  return w;
}

/**
 * Truncate to `max` columns, appending an ellipsis when it does not fit.
 *
 * ANSI-aware: escape sequences are copied through without consuming columns,
 * and a reset is appended when the cut lands inside a styled run. Truncating a
 * styled string with a naive slice would either bleed colour into the rest of
 * the line or strip it entirely.
 */
export function truncate(s: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;

  const eW = width(ellipsis);
  const budget = max - eW;
  let out = "";
  let w = 0;
  let styled = false;
  let i = 0;

  while (i < s.length) {
    if (s[i] === ESC) {
      const end = s.indexOf("m", i);
      if (end === -1) break;
      const seq = s.slice(i, end + 1);
      out += seq;
      styled = seq !== RESET;
      i = end + 1;
      continue;
    }
    const cp = String.fromCodePoint(s.codePointAt(i)!);
    const cw = cellWidth(cp);
    if (w + cw > budget) break;
    out += cp;
    w += cw;
    i += cp.length;
  }

  return out + (styled ? RESET : "") + ellipsis;
}

/**
 * Column width of a single grapheme.
 *
 * `string-width` reports East Asian Ambiguous characters as 2 columns, but
 * every terminal we target draws these particular symbols in 1. Trusting the
 * library here shifts whole columns of the widget out of alignment, so the
 * handful of glyphs the UI actually uses are pinned to 1.
 */
const AMBIGUOUS_SINGLE = new Set([
  "\u26a0", // warning sign
  "\u21b7", // clockwise top semicircle arrow
  "\u25b8", // small right-pointing triangle
  "\u2713", // check mark
  "\u2261", // identical to
  "\u2022", // bullet
  "\u00b7", // middle dot
  "\u2500", // box drawing light horizontal
]);

export function cellWidth(ch: string): number {
  if (AMBIGUOUS_SINGLE.has(ch)) return 1;
  try {
    return stringWidth(ch);
  } catch {
    return 1;
  }
}

/** Pad on the right to exactly `n` columns (no-op if already wider). */
export function padEnd(s: string, n: number): string {
  const w = width(s);
  return w >= n ? s : s + " ".repeat(n - w);
}

export function padStart(s: string, n: number): string {
  const w = width(s);
  return w >= n ? s : " ".repeat(n - w) + s;
}

/**
 * Wrap to `max` columns on word boundaries, hard-splitting words that cannot
 * fit. Never truncates — plan text the human needs to read stays readable.
 */
export function wrap(text: string, max: number): string[] {
  if (max <= 0) return [text];
  if (text === "") return [""];
  if (width(text) <= max) return [text];

  const lines: string[] = [];
  let cur = "";

  for (const word of text.split(" ")) {
    if (width(word) > max) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      let chunk = "";
      for (const ch of word) {
        if (width(chunk) + width(ch) > max) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      if (chunk) cur = chunk;
      continue;
    }
    if (!cur) cur = word;
    else if (width(cur) + 1 + width(word) <= max) cur += " " + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// -- Colour ------------------------------------------------------------------

export type ColorMode = "none" | "ansi256" | "truecolor";

export type Role =
  | "brand"
  | "accent"
  | "success"
  | "active"
  | "pending"
  | "blocked"
  | "rework"
  | "muted"
  | "text"
  | "rule";

export type Styler = {
  mode: ColorMode;
  fg(role: Role, s: string): string;
  bold(s: string): string;
  dim(s: string): string;
  hex(hex: string, s: string): string;
};

/**
 * Palette. Chosen to stay legible on both light and dark terminals: every
 * colour sits in the mid-luminance band rather than at either extreme, so
 * nothing disappears into the background on one theme or the other.
 */
export const PALETTE: Record<Role, string> = {
  brand: "#7C5CFF",
  accent: "#00B8D4",
  success: "#2E9E5B",
  active: "#D98A00",
  pending: "#8A8F98",
  blocked: "#D64545",
  rework: "#B36BD4",
  muted: "#6E7481",
  text: "#C9CDD4",
  rule: "#4A5058",
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

/** Nearest xterm-256 index for an RGB triple (6x6x6 cube + grey ramp). */
function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.INFINITY_HARNESS_COLOR === "0" || env.INFINITY_HARNESS_COLOR === "none") return "none";
  if (env.INFINITY_HARNESS_COLOR === "truecolor") return "truecolor";
  if (env.INFINITY_HARNESS_COLOR === "256") return "ansi256";
  if (env.FORCE_COLOR === "0") return "none";
  const ct = env.COLORTERM ?? "";
  if (ct.includes("truecolor") || ct.includes("24bit")) return "truecolor";
  const term = env.TERM ?? "";
  if (term === "dumb") return "none";
  if (term.includes("256")) return "ansi256";
  if (env.FORCE_COLOR) return "ansi256";
  if (term) return "ansi256";
  return "none";
}

export function createStyler(mode: ColorMode = detectColorMode()): Styler {
  if (mode === "none") {
    const id = (s: string): string => s;
    return { mode, fg: (_r, s) => s, bold: id, dim: id, hex: (_h, s) => s };
  }
  const sgr = (open: string, s: string): string => ESC + "[" + open + "m" + s + ESC + "[0m";
  const hex = (h: string, s: string): string => {
    const [r, g, b] = hexToRgb(h);
    return mode === "truecolor"
      ? sgr("38;2;" + r + ";" + g + ";" + b, s)
      : sgr("38;5;" + rgbTo256(r, g, b), s);
  };
  return {
    mode,
    hex,
    fg: (role, s) => hex(PALETTE[role], s),
    bold: (s) => sgr("1", s),
    dim: (s) => sgr("2", s),
  };
}

// -- Glyphs ------------------------------------------------------------------

export type GlyphSet = {
  pending: string;
  inProgress: string;
  complete: string;
  blocked: string;
  rework: string;
  subPending: string;
  subActive: string;
  subDone: string;
  barFull: string;
  barEmpty: string;
  arrow: string;
  more: string;
  branch: string;
  phaseDone: string;
  phaseCurrent: string;
  phaseTodo: string;
  rail: string;
};

export const UNICODE_GLYPHS: GlyphSet = {
  pending: "○",
  inProgress: "◐",
  complete: "●",
  blocked: "⚠",
  rework: "↷",
  subPending: "·",
  subActive: "▸",
  subDone: "✓",
  barFull: "▰",
  barEmpty: "▱",
  arrow: "←",
  more: "⋯",
  branch: "▸",
  phaseDone: "●",
  phaseCurrent: "◉",
  phaseTodo: "○",
  rail: "─",
};

export const ASCII_GLYPHS: GlyphSet = {
  pending: "o",
  inProgress: "*",
  complete: "x",
  blocked: "!",
  rework: "~",
  subPending: ".",
  subActive: ">",
  subDone: "+",
  barFull: "#",
  barEmpty: "-",
  arrow: "<-",
  more: "...",
  branch: ">",
  phaseDone: "x",
  phaseCurrent: "O",
  phaseTodo: "o",
  rail: "-",
};

export function detectGlyphs(env: NodeJS.ProcessEnv = process.env): GlyphSet {
  if (env.INFINITY_HARNESS_ASCII === "1") return ASCII_GLYPHS;
  const enc = (env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "").toLowerCase();
  if (enc && !enc.includes("utf")) return ASCII_GLYPHS;
  return UNICODE_GLYPHS;
}
