import assert from "node:assert/strict";
import {
  ASCII_GLYPHS,
  PALETTE,
  UNICODE_GLYPHS,
  cellWidth,
  createStyler,
  detectColorMode,
  detectGlyphs,
  padEnd,
  padStart,
  stripAnsi,
  truncate,
  width,
  wrap,
} from "../src/ui/theme.ts";

const RESET = "\u001b[0m";
const RED = "\u001b[31m";

// ── width / stripAnsi ──────────────────────────────────────────────────────
{
  assert.equal(width(""), 0);
  assert.equal(width("hello"), 5);
  assert.equal(width(`${RED}hello${RESET}`), 5, "ANSI escapes occupy no columns");
  assert.equal(stripAnsi(`${RED}hello${RESET}`), "hello");
  assert.equal(width("漢字"), 4, "CJK glyphs are two columns each");

  // These are the glyphs the UI actually draws. string-width reports some of
  // them as East Asian Ambiguous (2 columns); every terminal we target draws
  // them in 1, and the whole layout is built on that assumption.
  for (const glyph of ["⚠", "↷", "▸", "✓", "·"]) {
    assert.equal(cellWidth(glyph), 1, `${glyph} must measure 1 column`);
    assert.equal(width(glyph), 1, `${glyph} must measure 1 column`);
  }
  // A whole styled status row measures as its visible text.
  assert.equal(width(`${RED}⚠${RESET} 2 blocked`), 11);
  console.log("✓ width ignores ANSI and pins the ambiguous glyphs to one column");
}

// ── padEnd / padStart ──────────────────────────────────────────────────────
{
  assert.equal(padEnd("ab", 5), "ab   ");
  assert.equal(padStart("ab", 5), "   ab");
  assert.equal(padEnd("abcdef", 3), "abcdef", "padding never shortens");
  assert.equal(width(padEnd(`${RED}ab${RESET}`, 5)), 5, "padding measures visible width");
  assert.equal(width(padStart("⚠", 4)), 4);
  console.log("✓ padEnd/padStart pad to visible columns");
}

// ── truncate ───────────────────────────────────────────────────────────────
{
  assert.equal(truncate("hello", 10), "hello", "short strings pass through untouched");
  assert.equal(truncate("hello world", 8), "hello w…");
  assert.equal(width(truncate("hello world", 8)), 8);
  assert.equal(truncate("anything", 0), "", "a zero budget renders nothing");
  assert.equal(truncate("anything", -3), "");
  assert.equal(truncate("漢漢漢漢", 5), "漢漢…", "wide glyphs consume two columns of the budget");
  assert.equal(width(truncate("漢漢漢漢", 5)), 5);
  assert.equal(truncate("hello world", 8, "..."), "hello...");

  // ANSI-aware: escapes cost no budget, so a styled string keeps as much text
  // as the plain one.
  const styled = `${RED}hello world${RESET}`;
  const cut = truncate(styled, 8);
  assert.equal(width(cut), 8, "visible width respects the budget");
  assert.equal(stripAnsi(cut), "hello w…", "the same text survives as in the plain case");
  assert.ok(cut.endsWith(`${RESET}…`), "a cut inside a styled run is closed with a reset");
  assert.equal(cut.split(RED).length - 1, 1, "the opening escape is carried through, not duplicated");

  // A styled string that fits is returned verbatim, reset and all.
  assert.equal(truncate(styled, 40), styled);

  // A cut that lands after the run has already been reset needs no extra reset.
  const trailing = `${RED}ab${RESET}cdefghij`;
  const cutTrailing = truncate(trailing, 6);
  assert.equal(width(cutTrailing), 6);
  assert.equal(stripAnsi(cutTrailing), "abcde…");
  assert.equal(cutTrailing.split(RESET).length - 1, 1, "no redundant reset is appended");
  console.log("✓ truncate is ANSI-aware and budget-exact");
}

// ── wrap ───────────────────────────────────────────────────────────────────
{
  assert.deepEqual(wrap("", 10), [""]);
  assert.deepEqual(wrap("hello world", 20), ["hello world"], "text that fits is one line");
  assert.deepEqual(wrap("anything at all", 0), ["anything at all"], "a zero width disables wrapping");

  const text = "this is a fairly long label that has to wrap rather than be cut short";
  const lines = wrap(text, 20);
  assert.ok(lines.length > 1, "long text wraps");
  for (const l of lines) assert.ok(width(l) <= 20, `line over budget: ${JSON.stringify(l)}`);
  assert.ok(!lines.some((l) => l.includes("…")), "wrap never truncates");
  assert.equal(
    lines.join("").replace(/ /g, ""),
    text.replace(/ /g, ""),
    "every character survives the wrap",
  );

  // A word longer than the budget is hard-split rather than left to overflow.
  const long = "supercalifragilisticexpialidocious";
  const split = wrap(long, 10);
  assert.equal(split.length, 4);
  for (const l of split) assert.ok(width(l) <= 10);
  assert.equal(split.join(""), long, "a hard split loses nothing");

  // Mixed: short words, one monster, then short words again.
  const mixed = `short ${long} tail`;
  const mixedLines = wrap(mixed, 10);
  for (const l of mixedLines) assert.ok(width(l) <= 10, `line over budget: ${JSON.stringify(l)}`);
  assert.equal(mixedLines.join("").replace(/ /g, ""), mixed.replace(/ /g, ""));

  // Wide characters are measured in columns, not code points.
  const cjk = wrap("漢字漢字漢字漢字", 4);
  for (const l of cjk) assert.ok(width(l) <= 4);
  assert.equal(cjk.join(""), "漢字漢字漢字漢字");
  console.log("✓ wrap never truncates and hard-splits over-long words");
}

// ── createStyler ───────────────────────────────────────────────────────────
{
  const none = createStyler("none");
  assert.equal(none.mode, "none");
  const probe = "text ⚠ 42";
  assert.equal(none.fg("brand", probe), probe, "fg is a passthrough");
  assert.equal(none.bold(probe), probe, "bold is a passthrough");
  assert.equal(none.dim(probe), probe, "dim is a passthrough");
  assert.equal(none.hex("#7C5CFF", probe), probe, "hex is a passthrough");
  assert.equal(width(none.fg("blocked", probe)), width(probe));

  const truecolor = createStyler("truecolor");
  assert.equal(truecolor.hex("#7C5CFF", "x"), "\u001b[38;2;124;92;255mx\u001b[0m");
  assert.equal(truecolor.fg("brand", "x"), truecolor.hex(PALETTE.brand, "x"));
  assert.equal(truecolor.bold("x"), "\u001b[1mx\u001b[0m");
  assert.equal(truecolor.dim("x"), "\u001b[2mx\u001b[0m");
  assert.equal(stripAnsi(truecolor.fg("brand", probe)), probe, "colour adds no visible characters");

  const ansi256 = createStyler("ansi256");
  assert.equal(ansi256.hex("#7C5CFF", "x"), "\u001b[38;5;105mx\u001b[0m");
  assert.equal(ansi256.hex("#000000", "x"), "\u001b[38;5;16mx\u001b[0m", "pure black maps into the cube");
  assert.equal(stripAnsi(ansi256.fg("success", probe)), probe);
  console.log("✓ createStyler: none is a passthrough, colour modes emit the right SGR");
}

// ── detectColorMode ────────────────────────────────────────────────────────
{
  assert.equal(detectColorMode({}), "none", "no signal at all means no colour");
  assert.equal(detectColorMode({ NO_COLOR: "1", COLORTERM: "truecolor" }), "none", "NO_COLOR wins");
  assert.equal(
    detectColorMode({ NO_COLOR: "1", INFINITY_HARNESS_COLOR: "truecolor" }),
    "none",
    "NO_COLOR beats the harness override too",
  );
  assert.equal(
    detectColorMode({ NO_COLOR: "", COLORTERM: "truecolor" }),
    "truecolor",
    "an empty NO_COLOR is not a request for plain text",
  );

  assert.equal(detectColorMode({ INFINITY_HARNESS_COLOR: "0" }), "none");
  assert.equal(detectColorMode({ INFINITY_HARNESS_COLOR: "none" }), "none");
  assert.equal(detectColorMode({ INFINITY_HARNESS_COLOR: "truecolor", TERM: "dumb" }), "truecolor");
  assert.equal(detectColorMode({ INFINITY_HARNESS_COLOR: "256", COLORTERM: "truecolor" }), "ansi256");

  assert.equal(detectColorMode({ FORCE_COLOR: "0", TERM: "xterm-256color" }), "none");
  assert.equal(detectColorMode({ COLORTERM: "24bit" }), "truecolor");
  assert.equal(detectColorMode({ TERM: "dumb" }), "none");
  assert.equal(detectColorMode({ TERM: "xterm-256color" }), "ansi256");
  assert.equal(detectColorMode({ TERM: "xterm" }), "ansi256");
  assert.equal(detectColorMode({ FORCE_COLOR: "1" }), "ansi256");
  console.log("✓ detectColorMode honours NO_COLOR and INFINITY_HARNESS_COLOR");
}

// ── detectGlyphs ───────────────────────────────────────────────────────────
{
  assert.equal(detectGlyphs({}), UNICODE_GLYPHS);
  assert.equal(detectGlyphs({ INFINITY_HARNESS_ASCII: "1" }), ASCII_GLYPHS);
  assert.equal(detectGlyphs({ LANG: "en_US.UTF-8" }), UNICODE_GLYPHS);
  assert.equal(detectGlyphs({ LANG: "C" }), ASCII_GLYPHS, "a non-UTF locale gets the ASCII set");
  assert.equal(detectGlyphs({ LC_ALL: "C", LANG: "en_US.UTF-8" }), ASCII_GLYPHS, "LC_ALL wins");
  // The ASCII set must be a complete substitution — no missing key falls back
  // to a wide glyph the terminal cannot draw.
  for (const key of Object.keys(UNICODE_GLYPHS) as Array<keyof typeof UNICODE_GLYPHS>) {
    assert.equal(typeof ASCII_GLYPHS[key], "string", `ASCII_GLYPHS.${key} is missing`);
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x20-\x7e]+$/.test(ASCII_GLYPHS[key]), `ASCII_GLYPHS.${key} is not ASCII`);
  }
  console.log("✓ detectGlyphs and the ASCII fallback set");
}

console.log("All theme tests PASS");
