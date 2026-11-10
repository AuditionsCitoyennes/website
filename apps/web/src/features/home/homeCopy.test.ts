// The home page's copy keeps the site's French typography: a non-breaking
// space (`&nbsp;`) before : ; ? and inside « », straight apostrophes, no
// exclamation mark. The testimonies band's title stays two short lines, and
// the hero offers at most two buttons, the « Témoigner » popup, the
// testimonies page and the public auditions. Each section's root <template>
// is read (from the first <template> to the last </template> before <style>:
// some nest inner templates). Static: the files are read, not run. Run with
// `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOME = dirname(fileURLToPath(import.meta.url));

/** The page's sections (not DevHomeMapSwitch.vue: testing tools only). */
const SECTIONS = [
  "HeroSection.vue",
  "ProjectSection.vue",
  "TestimoniesSection.vue",
  "AuditionsSection.vue",
];

const source = (file: string) => readFileSync(join(HOME, file), "utf8");

function template(file: string): string {
  const s = source(file);
  return s.slice(s.indexOf("<template>") + 10, s.lastIndexOf("</template>", s.indexOf("<style")));
}

/** The visible text: no comments, no tags, no `{{ … }}`; entities kept as written. */
function text(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\{\{[\s\S]*?\}\}/g, "");
}

for (const file of SECTIONS) {
  test(`${file}: French typography`, () => {
    const t = text(template(file));
    assert.doesNotMatch(t, / [:;?!]/, "a plain space before : ; ? ! (use &nbsp;)");
    assert.doesNotMatch(t, /«(?!&nbsp;)/, "« not followed by &nbsp;");
    assert.doesNotMatch(t, /(?<!&nbsp;)»/, "» not preceded by &nbsp;");
    assert.doesNotMatch(t, /!/, "an exclamation mark");
    assert.doesNotMatch(t, /’/, "a typographic apostrophe (the site writes ')");
  });
}

test("TestimoniesSection.vue: the title is two short lines", () => {
  const h2 = /<h2 class="title">([\s\S]*?)<\/h2>/.exec(template("TestimoniesSection.vue"));
  assert.ok(h2, "no h2.title");
  const lines = h2[1].split("<br />");
  assert.equal(lines.length, 2, "exactly one <br />");
  for (const line of lines) {
    const shown = line
      .replace(/\s+/g, " ")
      .trim()
      .replace(/&nbsp;/g, " ");
    assert.ok(shown.length <= 22, `"${shown}" is over 22 characters`);
  }
});

test("HeroSection.vue: two buttons at most, and what can be done here", () => {
  const s = source("HeroSection.vue");
  const html = template("HeroSection.vue");
  const buttons = [...html.matchAll(/class="([^"]*)"/g)].filter((m) =>
    m[1].split(/\s+/).includes("cta-btn"),
  );
  assert.ok(buttons.length <= 2, `${buttons.length} cta-btn`);
  assert.match(s, /useSubmitTestimony\(\)/);
  assert.match(html, /testify\.show\(\)/);
  assert.match(html, /ROUTE\.temoignages\.path/);
  assert.match(html, /href="#auditions-publiques"/);
});
