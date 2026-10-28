// The Témoignages tree from the server (map phase 1, design E2): the units and
// lieux /api/places answers, per filter key, merged as they come — the tree
// the map and the panel are built from (geo/treeFromUnits), every unit's
// analyses figures, and the place picker's tree (every audition on the map).
//
// - One store per filter key, plain and NOT reactive (thousands of rows at
//   scale): one `version` ref is bumped per answer merged into the store on
//   screen, as useCommuneGeo bumps per batch. The 4 latest keys are kept.
// - A unit's answer is a vue-query entry ([...placesKeys.all, key, unit,
//   depth, facts]): asked again it is served from there, abandoned it is
//   aborted. The units asked within 50 ms go out as one units= request.
// - A unit is `loaded` once its children and lieux are known: its own answer,
//   its parent's (depth 2 brings the children's), or a complete answer above
//   it (at most 600 units plus lieux: the whole subtree, production's case —
//   one answer and nothing is ever asked again).
// - A filter change keeps the tree on screen until the new key's answer has
//   the scope and the units above it (D6): the scope's chain is asked for in
//   one request (only the world when the previous world answer was complete),
//   and the store is swapped in once it holds them — the plateau neither
//   sinks nor rises.
// - 429 and 503 (and a network failure) are retried after Retry-After, or 1,
//   2 and 4 s; then the unit is `failed` (the panel's error line) until the
//   scope changes.

import { ref } from "vue";
import { isCancelledError, type QueryClient } from "@tanstack/vue-query";
import type { PlaceCounts, PlaceFacts, PlaceLieuRow, PlaceUnitRow } from "@ac/shared";
import { WORLD, type UnitTreeData, type UnitTreeEntry } from "@/features/geo";
import { ApiError } from "@/shared/api/client";
import {
  createCountsBatcher,
  EMPTY_KEY,
  PLACES_DEPTH,
  placesKeys,
  type CountsRequest,
} from "./placesApi";

/** What the tree is asked under: a filter key and its parameters, or EMPTY_KEY. */
export interface TreeRequest {
  key: string;
  params: Readonly<Record<string, string>>;
}

/** Filter keys kept besides the one on screen. */
const KEYS_KEPT = 4;
/** Units asked within this window go out together. */
const WINDOW_MS = 50;
/** A unit's answer is fresh this long (the app's default). */
const STALE_MS = 5 * 60 * 1000;
/** Waits before each retry of a refused answer (unless Retry-After says). */
const RETRY_MS = [1000, 2000, 4000];

interface Entry extends UnitTreeEntry {
  row: PlaceUnitRow | null;
  childIds?: string[];
  lieuIds?: string[];
  /** Its figures from its own answer (`self.facts`). */
  facts?: PlaceFacts;
}

/** One filter key's store: plain objects, never made reactive. */
class KeyStore implements UnitTreeData {
  readonly units = new Map<string, Entry>();
  readonly lieux = new Map<string, PlaceLieuRow>();
  /** The world's answer (its self and unplaced counts). */
  root: PlaceCounts | null = null;
  /** Bumped at each merge. */
  version = 0;
  /** Units on their way, each with its request's token: an abandoned
   *  request's late end leaves a newer one's mark alone. */
  readonly inflight = new Map<string, number>();
  /** Waiting to be asked again. */
  readonly waiting = new Set<string>();
  readonly attempts = new Map<string, number>();
  readonly failed = new Set<string>();
  readonly timers = new Set<number>();
  /** Units asked for (the probe's count). */
  asked = 0;
  constructor(readonly req: CountsRequest) {}

  entry(id: string): Entry {
    let e = this.units.get(id);
    if (!e) {
      e = { row: null, loaded: false };
      this.units.set(id, e);
    }
    return e;
  }

  /** The world's answer held the whole tree. */
  get complete(): boolean {
    return this.root?.complete === true;
  }
}

function retryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 502;
  // A request that never got an answer (offline, the API down).
  return err instanceof TypeError;
}

export interface UnitTreeOptions {
  queryClient: QueryClient;
  /** An answer said its text was ignored (shorter than the API searches). */
  onTextIgnored?: (req: CountsRequest) => void;
}

export function useUnitTree(opts: UnitTreeOptions) {
  const { queryClient } = opts;

  /** Bumped at each answer merged into the store on screen, and at each swap:
   *  what the tree and the figures follow. */
  const version = ref(0);
  /** Bumped when what is loading or failed changes (the curtain, the panel's
   *  error line). */
  const status = ref(0);
  /** Bumped at each answer merged into another store (the next key's, the
   *  place picker's). */
  const sideVersion = ref(0);

  const stores = new Map<string, KeyStore>();
  /** Request tokens (KeyStore.inflight). */
  let asks = 0;
  /** The store on screen; null until the first one holds the world. */
  let shown: KeyStore | null = null;
  /** The key asked for, while its store is not on screen yet. */
  let next: KeyStore | null = null;
  /** The scope and the units above it, root first (setScope). */
  let chain: string[] = [WORLD];

  const batcher = createCountsBatcher({
    windowMs: WINDOW_MS,
    onAnswers(req, answers, textIgnored) {
      if (textIgnored) opts.onTextIgnored?.(req);
      const ks = stores.get(req.key);
      if (ks?.req === req) merge(ks, answers);
    },
  });

  /** Merges answers into a store (one bump). */
  function merge(ks: KeyStore, answers: PlaceCounts[]) {
    for (const a of answers) {
      const self = ks.entry(a.unit);
      if (a.unit === WORLD) ks.root = a;
      else if (a.self.facts) self.facts = a.self.facts;
      const loaded = new Set<string>([a.unit]);
      const childrenOf = new Map<string, string[]>();
      for (const r of a.units) {
        const e = ks.entry(r.id);
        // A child's facts come with its parent's answer; a deeper one's not.
        e.row = r.facts || !e.row?.facts ? r : { ...r, facts: e.row.facts };
        if (a.complete || r.d <= PLACES_DEPTH - 1) loaded.add(r.id);
        const parent = r.parent ?? WORLD;
        const kids = childrenOf.get(parent);
        if (kids) kids.push(r.id);
        else childrenOf.set(parent, [r.id]);
      }
      const lieuxOf = new Map<string, string[]>();
      for (const l of a.lieux) {
        const had = ks.lieux.get(l.id);
        ks.lieux.set(l.id, l.list || !had?.list ? l : { ...l, list: had.list });
        const ids = lieuxOf.get(l.unit);
        if (ids) ids.push(l.id);
        else lieuxOf.set(l.unit, [l.id]);
      }
      for (const id of loaded) {
        const e = ks.entry(id);
        e.childIds = childrenOf.get(id) ?? [];
        e.lieuIds = lieuxOf.get(id) ?? [];
        e.loaded = true;
        ks.failed.delete(id);
        ks.attempts.delete(id);
      }
    }
    ks.version++;
    if (ks === shown) version.value++;
    else sideVersion.value++;
    if (ks === next) settleNext();
  }

  /** Whether the store knows the scope and every unit above it: each is
   *  loaded, or absent from its loaded parent (nothing matches there). */
  function chainKnown(ks: KeyStore): boolean {
    for (let i = 0; i < chain.length; i++) {
      if (ks.units.get(chain[i])?.loaded) continue;
      const parent = i > 0 ? ks.units.get(chain[i - 1]) : undefined;
      return !!parent?.loaded && !parent.childIds?.includes(chain[i]);
    }
    return true;
  }

  /** The next key's store: on screen once it knows the scope's chain, else
   *  the rest of the chain asked for. */
  function settleNext() {
    const ks = next;
    if (!ks) return;
    if (chainKnown(ks)) {
      shown = ks;
      next = null;
      version.value++;
      status.value++;
      trim();
      return;
    }
    ensureIn(ks, chain, true);
  }

  /** Asks a store for these units' subtrees, unless known, on their way, or
   *  failed. Fresh answers in the cache are merged at once (one bump). */
  function ensureIn(ks: KeyStore, ids: readonly string[], now = false) {
    const cached: PlaceCounts[] = [];
    for (const id of ids) {
      if (ks.units.get(id)?.loaded) continue;
      if (ks.inflight.has(id) || ks.waiting.has(id) || ks.failed.has(id)) continue;
      const key = placesKeys.counts(ks.req.key, id, PLACES_DEPTH, ks.req.facts);
      const state = queryClient.getQueryState<PlaceCounts>(key);
      if (
        state?.data &&
        state.status === "success" &&
        Date.now() - state.dataUpdatedAt < STALE_MS
      ) {
        cached.push(state.data);
        continue;
      }
      const token = ++asks;
      ks.inflight.set(id, token);
      ks.asked++;
      queryClient
        .fetchQuery({
          queryKey: key,
          queryFn: ({ signal }) => batcher.load(ks.req, id, signal, now),
          retry: false,
          staleTime: STALE_MS,
        })
        .then(
          (answer) => {
            if (ks.inflight.get(id) === token) ks.inflight.delete(id);
            // Merged as it came (the batcher's onAnswers), unless another
            // reader's request brought it.
            if (!ks.units.get(id)?.loaded && stores.get(ks.req.key) === ks) merge(ks, [answer]);
          },
          (err) => {
            if (ks.inflight.get(id) !== token) return; // abandoned, asked again since
            ks.inflight.delete(id);
            if (!isCancelledError(err)) failedOnce(ks, id, err);
          },
        );
    }
    if (cached.length) merge(ks, cached);
  }

  function failedOnce(ks: KeyStore, id: string, err: unknown) {
    if (stores.get(ks.req.key) !== ks) return;
    const n = (ks.attempts.get(id) ?? 0) + 1;
    ks.attempts.set(id, n);
    if (!retryable(err) || n > RETRY_MS.length) {
      ks.failed.add(id);
      if (ks === shown || ks === next) status.value++;
      else sideVersion.value++;
      return;
    }
    const after = err instanceof ApiError ? err.retryAfter : null;
    const wait = after !== null ? Math.max(250, after * 1000) : RETRY_MS[n - 1];
    ks.waiting.add(id);
    const timer = window.setTimeout(() => {
      ks.timers.delete(timer);
      ks.waiting.delete(id);
      if (stores.get(ks.req.key) === ks) ensureIn(ks, [id]);
    }, wait);
    ks.timers.add(timer);
  }

  /** Abandons a store's requests on their way (it may ask again at once). */
  function abandon(ks: KeyStore) {
    if (!ks.inflight.size) return;
    ks.inflight.clear();
    void queryClient.cancelQueries({ queryKey: [...placesKeys.all, ks.req.key] });
  }

  /** Forgets a store: its requests abandoned, its retries dropped. */
  function drop(ks: KeyStore) {
    stores.delete(ks.req.key);
    for (const t of ks.timers) window.clearTimeout(t);
    ks.timers.clear();
    ks.waiting.clear();
    abandon(ks);
  }

  /** Keeps the latest filter keys, the one on screen and the next among them
   *  (the place picker's besides), and drops the rest. */
  function trim() {
    const live = [shown, next].filter((ks) => ks && ks.req.key !== EMPTY_KEY).length;
    const rest = [...stores.values()].filter(
      (ks) => ks !== shown && ks !== next && ks.req.key !== EMPTY_KEY,
    );
    const room = Math.max(0, KEYS_KEPT - live);
    for (const ks of rest.slice(0, Math.max(0, rest.length - room))) drop(ks);
  }

  function storeOf(req: TreeRequest): KeyStore {
    const known = stores.get(req.key);
    if (known) {
      // The most recent last.
      stores.delete(req.key);
      stores.set(req.key, known);
      return known;
    }
    const ks = new KeyStore({ key: req.key, params: req.params, facts: req.key !== EMPTY_KEY });
    stores.set(req.key, ks);
    return ks;
  }

  /**
   * The key the page asks for now. Its store goes on screen at once if it
   * already knows the scope; else the tree on screen stays while it asks
   * for the scope's chain — only the world when the previous world answer
   * was the whole tree (it will be again: one request).
   */
  function request(req: TreeRequest) {
    const ks = storeOf(req);
    if (next && next !== ks) {
      // Not wanted any more: its pending answers are abandoned.
      abandon(next);
      next = null;
    }
    status.value++;
    if (ks === shown) return;
    next = ks;
    trim();
    if (chainKnown(ks)) settleNext();
    else askChain(ks);
  }

  /** What a next key's store asks for first: the world alone when the
   *  previous world answer was the whole tree (so will this one be, most
   *  likely), else the scope's chain, in one request. */
  function askChain(ks: KeyStore) {
    ensureIn(ks, shown?.complete ? [WORLD] : chain, true);
  }

  /** The scope on screen changed: its chain is what a key change waits for;
   *  it and its parent are asked for, and what failed is tried again. */
  function setScope(scope: { id: string; ancestors: readonly string[] }) {
    chain = [...scope.ancestors, scope.id];
    let retried = false;
    for (const ks of [shown, next]) {
      if (!ks?.failed.size) continue;
      ks.failed.clear();
      ks.attempts.clear();
      retried = true;
    }
    if (retried) status.value++;
    if (shown) ensureIn(shown, chain.slice(-2));
    if (next) {
      if (chainKnown(next)) settleNext();
      else askChain(next);
    }
  }

  /** Asks the store on screen for these units' subtrees (those on view). */
  function ensure(ids: readonly string[]) {
    if (shown) ensureIn(shown, ids);
  }

  // ---- What is read (after `version`) ----

  /** The data on screen, or null before the first answer. */
  function data(): UnitTreeData | null {
    void version.value;
    return shown;
  }

  /** The key on screen ("" unfiltered, EMPTY_KEY the card's). */
  function shownKey(): string | null {
    void version.value;
    return shown?.req.key ?? null;
  }

  /** The key asked for last (on screen, or on its way). */
  function wantedKey(): string | null {
    void status.value;
    return (next ?? shown)?.req.key ?? null;
  }

  /** The world's answer on screen: N résultats = self.n + unplaced.n. */
  function root(): PlaceCounts | null {
    void version.value;
    return shown?.root ?? null;
  }

  /** Nothing on screen yet, and not failed. */
  function loading(): boolean {
    void status.value;
    return !shown && !next?.failed.size;
  }

  /** The tree could not be had: nothing on screen and the first key failed,
   *  the next key's chain failed, or this unit's answer did. */
  function failed(id?: string): boolean {
    void status.value;
    if (next?.failed.size && chain.some((c) => next!.failed.has(c))) return true;
    if (!shown) return !!next?.failed.size;
    return id !== undefined && shown.failed.has(id);
  }

  /** Every unit's figures on screen, by id (a unit's own answer's first). */
  function facts(): Map<string, PlaceFacts> {
    void version.value;
    const out = new Map<string, PlaceFacts>();
    if (!shown) return out;
    for (const [id, e] of shown.units) {
      const f = e.facts ?? e.row?.facts;
      if (f) out.set(id, f);
    }
    return out;
  }

  /** Every audition on the map (EMPTY_KEY), for the place picker: asked for
   *  once wanted; read after both versions. */
  function emptyData(): UnitTreeData | null {
    void version.value;
    void sideVersion.value;
    const ks = stores.get(EMPTY_KEY);
    return ks?.units.get(WORLD)?.loaded ? ks : null;
  }
  function wantEmpty() {
    const ks = stores.get(EMPTY_KEY) ?? storeOf({ key: EMPTY_KEY, params: {} });
    ensureIn(ks, [WORLD], true);
  }

  /** For the testing tools' probe. */
  function stats() {
    return {
      shown: shown?.req.key ?? null,
      next: next?.req.key ?? null,
      chain,
      keys: [...stores.keys()],
      units: shown?.units.size ?? 0,
      loaded: shown ? [...shown.units.values()].filter((e) => e.loaded).length : 0,
      lieux: shown?.lieux.size ?? 0,
      complete: shown?.complete ?? null,
      unitsAsked: [...stores.values()].reduce((s, ks) => s + ks.asked, 0),
      requests: batcher.sent(),
      inflight: [...stores.values()].reduce((s, ks) => s + ks.inflight.size, 0),
      failed: shown ? [...shown.failed] : [],
    };
  }

  return {
    version,
    status,
    sideVersion,
    request,
    setScope,
    ensure,
    data,
    shownKey,
    wantedKey,
    root,
    loading,
    failed,
    facts,
    emptyData,
    wantEmpty,
    stats,
  };
}

export type UnitTree = ReturnType<typeof useUnitTree>;
