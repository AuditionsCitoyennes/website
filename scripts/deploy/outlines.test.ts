// scripts/deploy/outlines.sh against a toy build packed the way
// build-outlines.sh release packs one (`tar -czf … -C <out> <build>`), with a
// stand-in `gh` on PATH: the deploy serves the locked build or fails, never
// half of it. No network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const SCRIPT = fileURLToPath(new URL("./outlines.sh", import.meta.url));
const BUILD = "o20261101-1";
const ASSET = `outlines-${BUILD}.tar.gz`;
// What deploy-staging-web.yml's Build step writes, byte for byte.
const HEADERS = "/*\n  X-Robots-Tag: noindex, nofollow\n";
const HEADERS_AFTER =
  HEADERS + "\n/map-data/*\n  Cache-Control: public, max-age=31536000, immutable\n";

const tmp = mkdtempSync(join(tmpdir(), "ac-outlines-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let cases = 0;

interface Toy {
  manifestBuild?: string;
  manifestFiles?: number;
  /** Extra top-level directory beside <build>/. */
  outside?: boolean;
  /** One more file entry, by its path in the archive (a ._* or a .. one). */
  extra?: string;
}

// macOS tar folds a ._* file into its sibling's metadata (and drops it under
// --no-xattrs), and no tar writes a .. path, so the tarball with such an entry
// is written here: plain ustar.
function ustar(entries: { name: string; data?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, data } of entries) {
    const body = Buffer.from(data ?? "");
    const h = Buffer.alloc(512);
    const put = (s: string, at: number) => h.write(s, at, "latin1");
    put(name, 0);
    put(data === undefined ? "0000755\0" : "0000644\0", 100);
    put("0000000\0", 108);
    put("0000000\0", 116);
    put(body.length.toString(8).padStart(11, "0") + "\0", 124);
    put("00000000000\0", 136);
    put("        ", 148);
    put(data === undefined ? "5" : "0", 156);
    put("ustar\u000000", 257);
    let sum = 0;
    for (const byte of h) sum += byte;
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** A tarball of a 4-file build (root, manifest, NOTICE, k/FR); its path and sha256. */
function pack(dir: string, toy: Toy = {}): { tarball: string; sha256: string } {
  const src = join(dir, "src");
  const b = join(src, BUILD);
  mkdirSync(join(b, "k"), { recursive: true });
  const json = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v));
  json(join(b, "root.json"), { v: 1, build: BUILD, tiers: {}, units: [] });
  json(join(b, "k", "FR.json"), { v: 1, build: BUILD, kind: "k", id: "FR", units: [] });
  writeFileSync(join(b, "NOTICE.txt"), "Etalab, Licence Ouverte\n");
  json(join(b, "manifest.json"), {
    v: 1,
    build: toy.manifestBuild ?? BUILD,
    files: toy.manifestFiles ?? 4,
  });
  const tarball = join(dir, ASSET);
  if (toy.extra) {
    const files = ["root.json", "manifest.json", "NOTICE.txt", "k/FR.json"];
    const tar = ustar([
      { name: `${BUILD}/` },
      { name: `${BUILD}/k/` },
      ...files.map((p) => ({ name: `${BUILD}/${p}`, data: readFileSync(join(b, p), "utf8") })),
      { name: toy.extra, data: "not an outline" },
    ]);
    writeFileSync(tarball, tar);
    return { tarball, sha256: createHash("sha256").update(tar).digest("hex") };
  }
  const tops = [BUILD];
  if (toy.outside) {
    mkdirSync(join(src, "other"));
    writeFileSync(join(src, "other", "x.json"), "{}");
    tops.push("other");
  }
  const r = spawnSync("tar", ["--no-xattrs", "-czf", tarball, "-C", src, ...tops], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  return { tarball, sha256 };
}

interface Run {
  status: number | null;
  stderr: string;
  stdout: string;
}

/** A fresh case directory: lock, dist with Build's _headers, work dir, gh shim. */
function setup(lock: unknown, { headers = true }: { headers?: boolean } = {}) {
  const dir = join(tmp, `case-${++cases}`);
  const bin = join(dir, "bin");
  const dist = join(dir, "dist");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dist);
  if (headers) writeFileSync(join(dist, "_headers"), HEADERS);
  const lockPath = join(dir, "outlines.lock.json");
  if (lock !== undefined) {
    writeFileSync(lockPath, typeof lock === "string" ? lock : JSON.stringify(lock));
  }
  // A gh that has no such release: exits 1 and logs its arguments.
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\necho "$*" >> "${join(dir, "gh.log")}"\necho "release not found" >&2\nexit 1\n`,
  );
  chmodSync(gh, 0o755);
  const run = (cmd: "fetch" | "install", env: Record<string, string> = {}): Run => {
    const base: Record<string, string | undefined> = { ...process.env };
    // CI runs this test inside a workflow: keep its own files out of reach.
    for (const k of [
      "GITHUB_OUTPUT",
      "GITHUB_STEP_SUMMARY",
      "GITHUB_REPOSITORY",
      "RUNNER_TEMP",
      "OUTLINES_TARBALL",
    ]) {
      delete base[k];
    }
    const r = spawnSync("bash", [SCRIPT, cmd], {
      env: {
        ...base,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        LOCK: lockPath,
        DIST: dist,
        WORK: join(dir, "work"),
        GITHUB_OUTPUT: join(dir, "github-output"),
        GITHUB_STEP_SUMMARY: join(dir, "step-summary"),
        ...env,
      },
      encoding: "utf8",
    });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout };
  };
  return { dir, dist, run };
}

const lockOf = (sha256: string) => ({ build: BUILD, asset: ASSET, sha256 });

function fails(r: Run, text: string | RegExp) {
  assert.notEqual(r.status, 0, `expected a failure, got 0: ${r.stdout}`);
  assert.ok(r.stderr.includes("::error::"), r.stderr);
  const found = typeof text === "string" ? r.stderr.includes(text) : text.test(r.stderr);
  assert.ok(found, `"${text}" not in: ${r.stderr}`);
}

test("ok: the build lands at dist/map-data/outlines/<build>/, _headers appended", () => {
  const toy = pack(mkdtempSync(join(tmp, "toy-")));
  const { dir, dist, run } = setup(lockOf(toy.sha256));
  const f = run("fetch", { OUTLINES_TARBALL: toy.tarball });
  assert.equal(f.status, 0, f.stderr);
  const i = run("install");
  assert.equal(i.status, 0, i.stderr);
  const out = join(dist, "map-data", "outlines", BUILD);
  assert.ok(existsSync(join(out, "root.json")));
  assert.ok(existsSync(join(out, "k", "FR.json")));
  assert.ok(!existsSync(join(out, BUILD)), "no double <build>/");
  assert.equal(readFileSync(join(dist, "_headers"), "utf8"), HEADERS_AFTER);
  const output = readFileSync(join(dir, "github-output"), "utf8");
  assert.ok(output.includes(`build=${BUILD}\n`), output);
  assert.match(output, /^largest=(root\.json|manifest\.json|NOTICE\.txt|k\/FR\.json)$/m);
  assert.ok(readFileSync(join(dir, "step-summary"), "utf8").includes("| Outline files | 4 |"));
});

test("lock absent", () => {
  const { run } = setup(undefined);
  fails(run("fetch"), "outlines.lock.json missing");
});

test("lock malformed: build, asset, sha256", () => {
  const sha = "a".repeat(64);
  fails(
    setup({ build: "o2026-1", asset: "outlines-o2026-1.tar.gz", sha256: sha }).run("fetch"),
    '"build"',
  );
  fails(setup({ build: BUILD, asset: "../x.tar.gz", sha256: sha }).run("fetch"), '"asset"');
  fails(setup({ build: BUILD, asset: ASSET, sha256: "abc123" }).run("fetch"), '"sha256"');
  fails(setup("not json").run("fetch"), '"build"');
});

test("release missing: gh fails, the deploy fails", () => {
  const { dir, run } = setup(lockOf("a".repeat(64)));
  fails(
    run("fetch", { GITHUB_REPOSITORY: "AuditionsCitoyennes/website" }),
    `outline build ${BUILD} not released (release outlines-${BUILD}, asset ${ASSET})`,
  );
  const log = readFileSync(join(dir, "gh.log"), "utf8");
  assert.ok(log.includes(`release download outlines-${BUILD} -p ${ASSET}`), log);
  assert.ok(log.includes("--repo AuditionsCitoyennes/website"), log);
});

test("sha256 mismatch", () => {
  const toy = pack(mkdtempSync(join(tmp, "toy-")));
  const { run } = setup(lockOf("0".repeat(64)));
  fails(run("fetch", { OUTLINES_TARBALL: toy.tarball }), "sha256 is not the lock's");
});

test("layout: an entry outside <build>/, a ._* entry", () => {
  const outside = pack(mkdtempSync(join(tmp, "toy-")), { outside: true });
  fails(
    setup(lockOf(outside.sha256)).run("fetch", { OUTLINES_TARBALL: outside.tarball }),
    `an entry outside ${BUILD}/`,
  );
  const up = pack(mkdtempSync(join(tmp, "toy-")), { extra: `${BUILD}/../${BUILD}/x.json` });
  fails(
    setup(lockOf(up.sha256)).run("fetch", { OUTLINES_TARBALL: up.tarball }),
    "a .. or ._* entry",
  );
  // GNU tar (CI) lists a ._* entry; macOS tar reads it as its sibling's
  // metadata and, as that is junk here, cannot read the archive: both fail.
  const fork = pack(mkdtempSync(join(tmp, "toy-")), { extra: `${BUILD}/._root.json` });
  fails(
    setup(lockOf(fork.sha256)).run("fetch", { OUTLINES_TARBALL: fork.tarball }),
    /a \.\. or \._\* entry|not a readable \.tar\.gz/,
  );
});

test("manifest build is not the lock's", () => {
  const toy = pack(mkdtempSync(join(tmp, "toy-")), { manifestBuild: "o20990101-1" });
  const { run } = setup(lockOf(toy.sha256));
  assert.equal(run("fetch", { OUTLINES_TARBALL: toy.tarball }).status, 0);
  fails(run("install"), "manifest.json is not v1 of build");
});

test("file count is not the manifest's", () => {
  const toy = pack(mkdtempSync(join(tmp, "toy-")), { manifestFiles: 5 });
  const { run } = setup(lockOf(toy.sha256));
  assert.equal(run("fetch", { OUTLINES_TARBALL: toy.tarball }).status, 0);
  fails(run("install"), "4 files, the manifest says 5");
});

test("install before Build: no _headers", () => {
  const toy = pack(mkdtempSync(join(tmp, "toy-")));
  const { run } = setup(lockOf(toy.sha256), { headers: false });
  assert.equal(run("fetch", { OUTLINES_TARBALL: toy.tarball }).status, 0);
  fails(run("install"), "_headers missing: run after Build");
});
