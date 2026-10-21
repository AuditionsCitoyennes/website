// Every font size in the web app is one of the type scale's tokens (see the
// "Type scale" block in src/styles/global.css). This fails on any other value
// — a rem, a px, a clamp of its own — unless the line says why it must be an
// exception: a `type-exception: <reason>` comment on it or on the line above.
//
//   node apps/web/scripts/check-type-scale.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TOKENS = ["caption", "ui", "body", "input", "lead", "title", "section", "page", "display"];
const ALLOWED = new RegExp(`^(?:var\\(--text-(?:${TOKENS.join("|")})\\)|inherit)$`);

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(web, "src");

/** The text with its comments blanked out, line breaks kept. */
function withoutComments(text) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank);
}

const problems = [];
for (const entry of readdirSync(src, { recursive: true })) {
  const file = String(entry);
  if (!/\.(vue|css)$/.test(file)) continue;
  const text = readFileSync(join(src, file), "utf8");
  const lines = text.split("\n");
  const code = withoutComments(text);
  // A size in `font-size:`, or in the `font:` shorthand (unless it is inherited).
  const decl = /(?<![-\w])(font-size|font)\s*:\s*([^;{}"'\n]+)/g;
  for (const m of code.matchAll(decl)) {
    const value = m[2].trim();
    if (m[1] === "font" && /^inherit$/.test(value)) continue;
    if (m[1] === "font-size" && ALLOWED.test(value)) continue;
    const line = code.slice(0, m.index).split("\n").length;
    const near = `${lines[line - 2] ?? ""}\n${lines[line - 1]}`;
    if (/type-exception:/.test(near)) continue;
    problems.push(`${relative(process.cwd(), join(src, file))}:${line}  ${m[1]}: ${value}`);
  }
}

if (problems.length) {
  console.error(
    `Font sizes must be one of var(--text-{${TOKENS.join(",")}}) or inherit ` +
      `(see the type scale in apps/web/src/styles/global.css), or carry a ` +
      `"type-exception: <reason>" comment:\n` +
      problems.map((p) => `  ${p}`).join("\n"),
  );
  process.exit(1);
}
console.log("Type scale: every font size is a token.");
