// The glass blur survives the build (C33), run with `node --import tsx --test`
// (root "test:scripts"). Vite minifies CSS with Lightning CSS, which reads two
// declarations of one property, prefixed and not, as one: the later wins and
// the other is dropped. Written `backdrop-filter` then `-webkit-backdrop-filter`,
// the built file kept the prefixed form alone, which Chrome, Edge and Firefox
// ignore: they drew no blur. Two checks: the minifier's behaviour as the
// build uses it (both orders), then every stylesheet and component of the
// app writes the prefixed form first.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "lightningcss";

// Vite 8's default CSS targets (build.cssTarget "baseline-widely-available"):
// Chrome 111, Edge 111, Firefox 114, Safari 16.4 — Safari before 18 needs the prefix.
const TARGETS = {
  chrome: 111 << 16,
  edge: 111 << 16,
  firefox: 114 << 16,
  safari: (16 << 16) | (4 << 8),
};
const minify = (css: string) =>
  transform({
    filename: "x.css",
    code: Buffer.from(css),
    minify: true,
    targets: TARGETS,
  }).code.toString();

test("the minifier keeps both forms when the prefixed one comes first", () => {
  const out = minify(".a{-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}");
  assert.match(out, /-webkit-backdrop-filter:blur\(4px\)/);
  assert.match(out, /[{;]backdrop-filter:blur\(4px\)/);
  // The other order loses the unprefixed form: the cause of the missing blur.
  const lost = minify(".a{backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}");
  assert.doesNotMatch(lost, /[{;]backdrop-filter/);
});

const SRC = fileURLToPath(new URL("../..", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(css|vue)$/.test(name) ? [p] : [];
  });
}

test("every rule of the app writes -webkit-backdrop-filter before backdrop-filter", () => {
  let rules = 0;
  for (const file of files(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/^\s*backdrop-filter\s*:/.test(line)) return;
      rules++;
      const where = `${file.slice(SRC.length)}:${i + 1}`;
      assert.match(lines[i - 1] ?? "", /^\s*-webkit-backdrop-filter\s*:/, where);
      assert.doesNotMatch(lines[i + 1] ?? "", /^\s*-webkit-backdrop-filter\s*:/, where);
    });
  }
  assert.ok(rules >= 8, `${rules} rules found`);
});
