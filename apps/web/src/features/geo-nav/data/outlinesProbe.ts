// `window.__acOutlines()` — the outline files in the page, in the builds with
// the testing tools (loaded from the geo-nav barrel behind __TEST_TOOLS__, so a
// production build has no chunk for it). Installing it builds nothing: the
// page's instance (useOutlineFiles) is built at the first call.
//
//   const o = __acOutlines();          // a snapshot: mode, ready, counters…
//   await o.ensure("root");            // root.json, then k/FR
//   await o.ensure("k", "fr:dep:69");  // a bundle ("u": a self, "g": a globe)
//   o.same("fr:dep:69");               // its self IS its entry?
//   o.rawCheck();                      // every geometry plain, none reactive
import { isReactive } from "vue";
import { useOutlineFiles } from "./useOutlineFiles";

type ProbeKind = "root" | "k" | "u" | "g";

function snapshot() {
  const o = useOutlineFiles();
  return {
    mode: o.mode.value,
    ready: o.ready.value,
    build: o.build,
    base: o.base,
    version: o.version.value,
    ...o.stats(),
    loaded: o.loadedKeys(),
    failed: [...o.failed.value],
    gaveUp: [...o.gaveUp.value],
    async ensure(kind: ProbeKind, id = "") {
      if (kind === "root") return o.ensureRoot();
      if (kind === "k") return o.ensureBundle(id);
      if (kind === "u") return o.ensureSelf(id);
      return (await o.ensureGlobe([id]))[0];
    },
    prefetch: (kind: Exclude<ProbeKind, "root">, id: string) => o.prefetch(kind, id),
    same(id: string) {
      const row = o.rowOf(id);
      const entry = o.entryOf(id);
      return {
        selfTier: row?.st,
        // An entry comes from its parent's bundle, cut at the parent's own tier.
        entryTier: entry && row?.parent ? o.rowOf(row.parent)?.st : undefined,
        identical: o.selfOf(id) !== undefined && o.selfOf(id) === entry,
      };
    },
    rawCheck() {
      const all = o.wrapped();
      return {
        objects: o.stats().objects,
        wrapped: all.length,
        allSkip: all.every((g) => (g as { __v_skip?: unknown }).__v_skip === true),
        anyReactive: all.some((g) => isReactive(g)),
      };
    },
  };
}

(window as unknown as { __acOutlines?: typeof snapshot }).__acOutlines = snapshot;
