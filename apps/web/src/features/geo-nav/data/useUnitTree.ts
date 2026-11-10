// The Témoignages tree from the server (map phase 1, design E2): the units and
// lieux /api/places answers, per filter key, merged as they come — the tree
// the map and the panel are built from (geo/treeFromUnits), every unit's
// analyses figures, and the place picker's tree (every audition on the map).
//
// - One store per filter key, plain and NOT reactive (thousands of rows at
//   scale): one `version` ref is bumped per answer merged into the store on
//   screen, as the outline files' store bumps per write. The 4 latest keys
//   are kept.
// - A unit's answer is a vue-query entry ([...placesKeys.all, key, unit,
//   depth, facts]): asked again it is served from there, abandoned it is
//   aborted. The units asked within 50 ms go out as one units= request.
// - A unit is `loaded` once its children and lieux are known: its own answer,
//   its parent's (depth 2 brings the children's), or a complete answer above
//   it (at most 600 units plus lieux: the whole subtree, production's case —
//   one answer and nothing is ever asked again). It is `own` once its
//   children are loaded too: its own answer, or a complete one.
// - A filter change keeps the tree on screen until the new key's answer has
//   the scope and the units above it (D6): the scope's chain is asked for in
//   one request (only the world when the previous world answer was complete),
//   and the store is swapped in once it holds them — the plateau neither
//   sinks nor rises.
// - 429 and 503 (and a network failure) are retried after Retry-After, or 1,
//   2 and 4 s, while the key is wanted; then the unit is `failed` (the panel's
//   error line) until the scope changes or the key is asked for again.
// - A lieu a list knows before the tree does (a result opened on the lazy
//   path) is held as a stub under its unit, its path asked for meanwhile
//   (PR K): selected, flown to and labelled at once, its own row replacing it
//   — or, its unit loaded without it, gone (it does not match there). The
//   open lieu goes along, as a stub, into a key's store swapped in without it.
// - An audition created (keys.ts' reloadPlaces, from app/AppDialogs.vue)
//   drops every store, 100 ms after the last one: the key on screen is asked
//   for again — its scope's chain, as for a filter change — and swapped in
//   once the answer holds it, the tree before on screen meanwhile; the place
//   picker's too, if it was wanted. Told directly, not by the query cache's
//   invalidate events: none comes for a query already invalidated (a reload
//   still on its way, or one that failed).

import { getCurrentScope, onScopeDispose, ref } from "vue";
import { isCancelledError, type QueryClient } from "@tanstack/vue-query";
import type { PlaceCounts, PlaceFacts, PlaceLieuRow, PlaceUnitRow } from "@ac/shared";
import {
  serverChainOf,
  WORLD,
  type LieuStub,
  type UnitTreeData,
  type UnitTreeEntry,
} from "@/features/geo";
import { onPlacesReload } from "../keys";
import {
  createCountsBatcher,
  EMPTY_KEY,
  PLACES_DEPTH,
  placesKeys,
  retryable,
  retryWait,
  RETRIES,
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
/** After the last reload asked for (an audition created), the stores are. */
const REFRESH_MS = 100;

interface Entry extends UnitTreeEntry {
  row: PlaceUnitRow | null;
  childIds?: string[];
  lieuIds?: string[];
  /** Its children are loaded too: its own answer, or a complete one, is in. */
  own?: boolean;
  /** Its figures from its own answer (`self.facts`). */
  facts?: PlaceFacts;
}

/** One filter key's store: plain objects, never made reactive. */
class KeyStore implements UnitTreeData {
  readonly units = new Map<string, Entry>();
  readonly lieux = new Map<string, PlaceLieuRow>();
  /** Lieux opened from a list before the tree held them. */
  readonly stubs = new Map<string, LieuStub>();
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
  /** Each unit waiting to be asked again: its timer. */
  readonly timers = new Map<string, number>();
  /** Units asked for (the probe's count). */
  asked = 0;
  /** Reloaded: on screen until its reload is (see refresh), never asked for
   *  again nor handed out by storeOf. */
  stale = false;
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

export interface UnitTreeOptions {
  queryClient: QueryClient;
  /** An answer said its text was ignored (shorter than the API searches,
   *  `minChars` when it says how short). */
  onTextIgnored?: (req: CountsRequest, minChars: number | undefined) => void;
  /** The place reads (placesApi's fetchCounts; a fake in the tests). */
  fetch?: Parameters<typeof createCountsBatcher>[0]["fetch"];
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
  /** The place picker's store before a reload, read until its own reload
   *  holds the world and the places opened in it (see settleEmpty). */
  let staleEmpty: KeyStore | null = null;
  /** The units the place picker asked for as they were opened (loadEmpty),
   *  on the lazy path: asked for again with its reload. */
  const pickerOpened = new Set<string>();
  /** The filter dialog is closed: the places opened in the picker are not
   *  asked for again after a refusal (the world is: the chips read it). */
  let pickerIdle = false;
  /** The reload after an audition created, waiting for the last one. */
  let refreshTimer = 0;
  /** Reloads after an audition created (the probe's count). */
  let refreshes = 0;

  const batcher = createCountsBatcher({
    windowMs: WINDOW_MS,
    fetch: opts.fetch,
    onAnswers(req, answers, ignored) {
      if (ignored) opts.onTextIgnored?.(req, ignored.minChars);
      const ks = stores.get(req.key);
      if (ks?.req === req) merge(ks, answers);
    },
  });

  /** Merges answers into a store (one bump). */
  function merge(ks: KeyStore, answers: PlaceCounts[]) {
    for (const a of answers) {
      const self = ks.entry(a.unit);
      self.own = true;
      if (a.unit === WORLD) ks.root = a;
      else if (a.self.facts) self.facts = a.self.facts;
      const loaded = new Set<string>([a.unit]);
      const childrenOf = new Map<string, string[]>();
      for (const r of a.units) {
        const e = ks.entry(r.id);
        // A child's facts come with its parent's answer; a deeper one's not.
        e.row = r.facts || !e.row?.facts ? r : { ...r, facts: e.row.facts };
        if (a.complete) e.own = true;
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
    settleEmpty(ks);
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
      // The tree left: what it still asked for is let go.
      const from = shown;
      if (from && from !== ks && from.req.key !== EMPTY_KEY) abandon(from);
      shown = ks;
      next = null;
      if (from && from !== ks) carryInto(ks, from);
      version.value++;
      status.value++;
      // A store a reload left on screen: gone now.
      if (from?.stale && stores.get(from.req.key) === from) drop(from);
      trim();
      return;
    }
    ensureIn(ks, chain, true);
  }

  /** Asks a store for these units' subtrees, unless known (`deep`: their
   *  children's too), on their way, or failed. Fresh answers in the cache are
   *  merged at once (one bump). */
  function ensureIn(ks: KeyStore, ids: readonly string[], now = false, deep = false) {
    const cached: PlaceCounts[] = [];
    for (const id of ids) {
      const known = ks.units.get(id);
      if (deep ? known?.own : known?.loaded) continue;
      if (ks.inflight.has(id) || ks.waiting.has(id) || ks.failed.has(id)) continue;
      const key = placesKeys.counts(ks.req.key, id, PLACES_DEPTH, ks.req.facts);
      const state = queryClient.getQueryState<PlaceCounts>(key);
      if (
        state?.data &&
        state.status === "success" &&
        !state.isInvalidated &&
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
            if (!ks.units.get(id)?.own && stores.get(ks.req.key) === ks) merge(ks, [answer]);
          },
          (err) => {
            if (ks.inflight.get(id) !== token) return; // abandoned, asked again since
            ks.inflight.delete(id);
            if (!isCancelledError(err)) failedOnce(ks, id, err, deep);
          },
        );
    }
    if (cached.length) merge(ks, cached);
  }

  /** The store is wanted for this unit: on screen, asked for, or the place
   *  picker's — its world always (the chips read it), the places opened in it
   *  while the filter dialog is open, or while its reload brings them back. */
  function wanted(ks: KeyStore, id: string): boolean {
    if (ks === shown || ks === next) return true;
    if (ks.req.key !== EMPTY_KEY) return false;
    return id === WORLD || !pickerIdle || (staleEmpty !== null && pickerOpened.has(id));
  }

  /** A unit's read failed: asked again (as it was: `deep`) while the store is
   *  wanted, or marked failed. A place picker's read no longer wanted is let
   *  go: asked for again when opened again. */
  function failedOnce(ks: KeyStore, id: string, err: unknown, deep: boolean) {
    if (stores.get(ks.req.key) !== ks) return;
    if (!wanted(ks, id)) {
      if (ks.req.key === EMPTY_KEY) {
        ks.attempts.delete(id);
        settleEmpty(ks);
        bumpFor(ks);
      }
      return;
    }
    const n = (ks.attempts.get(id) ?? 0) + 1;
    ks.attempts.set(id, n);
    if (!retryable(err) || n > RETRIES) {
      ks.failed.add(id);
      settleEmpty(ks);
      bumpFor(ks);
      return;
    }
    ks.waiting.add(id);
    const timer = window.setTimeout(
      () => {
        ks.timers.delete(id);
        ks.waiting.delete(id);
        if (stores.get(ks.req.key) === ks && wanted(ks, id)) ensureIn(ks, [id], false, deep);
      },
      retryWait(n, err),
    );
    ks.timers.set(id, timer);
  }

  /** Whatever failed under a store is tried again when next wanted. */
  function forgetFailures(ks: KeyStore): boolean {
    if (!ks.failed.size && !ks.attempts.size) return false;
    ks.failed.clear();
    ks.attempts.clear();
    return true;
  }

  /** Abandons a store's requests on their way and its retries (it may ask
   *  again at once, from scratch). */
  function abandon(ks: KeyStore) {
    for (const t of ks.timers.values()) window.clearTimeout(t);
    ks.timers.clear();
    ks.waiting.clear();
    ks.attempts.clear();
    if (!ks.inflight.size) return;
    ks.inflight.clear();
    void queryClient.cancelQueries({ queryKey: [...placesKeys.all, ks.req.key] });
  }

  /** Forgets a store: its requests abandoned, its retries dropped, its
   *  answers out of the query cache (the LRU is the memory bound). */
  function drop(ks: KeyStore) {
    stores.delete(ks.req.key);
    abandon(ks);
    queryClient.removeQueries({ queryKey: [...placesKeys.all, ks.req.key] });
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
    if (known && !known.stale) {
      // The most recent last.
      stores.delete(req.key);
      stores.set(req.key, known);
      return known;
    }
    const ks = new KeyStore({ key: req.key, params: req.params, facts: req.key !== EMPTY_KEY });
    // In place of a stale one (still on screen until this one is).
    stores.delete(req.key);
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
    // Asked for again: what failed under it is tried again.
    forgetFailures(ks);
    next = ks;
    trim();
    if (chainKnown(ks)) settleNext();
    else askChain(ks);
  }

  /** What a next key's store asks for first: the world alone when the
   *  previous world answer was the whole tree (so will this one be, most
   *  likely) and this store does not hold its world yet, else the scope's
   *  chain, in one request. */
  function askChain(ks: KeyStore) {
    const worldFirst = shown?.complete === true && !ks.units.get(WORLD)?.loaded;
    ensureIn(ks, worldFirst ? [WORLD] : chain, true);
  }

  /** The scope on screen changed: its chain is what a key change waits for;
   *  it and its parent are asked for, and what failed is tried again. */
  function setScope(scope: { id: string; ancestors: readonly string[] }) {
    // The server's filing: an overseas région's département is in it, though
    // the tree folds it.
    chain = (shown && serverChainOf(shown, scope.id)) ?? [...scope.ancestors, scope.id];
    let retried = false;
    for (const ks of [shown, next]) if (ks && forgetFailures(ks)) retried = true;
    if (retried) status.value++;
    if (shown && !shown.stale) ensureIn(shown, chain.slice(-2));
    if (next) {
      if (chainKnown(next)) settleNext();
      else askChain(next);
    }
  }

  /** Asks the store on screen for these units' subtrees (those on view) —
   *  its reload's, while a reloaded one is on screen; `deep`: their
   *  children's too (the scope, so that the next drill step finds its units
   *  loaded). */
  function ensure(ids: readonly string[], deep = false) {
    const ks = shown?.stale ? next : shown;
    if (ks) ensureIn(ks, ids, false, deep);
  }

  /** A stub can stand in a store for this lieu: the store is not whole (it
   *  would hold it) and does not know its unit's lieux without it. */
  function stubFits(ks: KeyStore, lieu: LieuStub): boolean {
    if (ks.complete || ks.lieux.has(lieu.id) || ks.stubs.has(lieu.id)) return false;
    const unit = ks.units.get(lieu.unit);
    return !unit?.loaded || !!unit.lieuIds?.includes(lieu.id);
  }

  /**
   * A lieu a list holds (a result's row), into the tree on screen until its
   * own row comes: it can be selected, flown to and labelled at once. Its
   * path is asked for meanwhile. Whether it went in (not into a whole tree:
   * a lieu it lacks does not match).
   */
  function addStub(lieu: LieuStub): boolean {
    const ks = shown;
    if (!ks || !stubFits(ks, lieu)) return false;
    ks.stubs.set(lieu.id, lieu);
    ks.version++;
    version.value++;
    // Reloaded: its reload holds the stub too, and asks for its path.
    const reload = ks.stale && next?.req.key === ks.req.key ? next : null;
    if (reload && stubFits(reload, lieu)) {
      reload.stubs.set(lieu.id, lieu);
      reload.version++;
      ensureIn(reload, lieu.path);
    } else if (!ks.stale) ensureIn(ks, lieu.path);
    return true;
  }

  /** The lieu that goes along when the tree on screen changes (the open one). */
  let carry: (() => string | null) | null = null;
  function setCarry(fn: (() => string | null) | null) {
    carry = fn;
  }

  /** The open lieu, into a store swapped in without it (its stub, or one made
   *  from its row), its path asked for: it stays selected until the store
   *  knows its unit — and then whether it matches. */
  function carryInto(ks: KeyStore, from: KeyStore) {
    const id = carry?.();
    if (!id || ks.req.key === EMPTY_KEY) return;
    const stub = from.stubs.get(id) ?? stubOfRow(from, id);
    if (!stub || !stubFits(ks, stub)) return;
    ks.stubs.set(id, stub);
    ks.version++;
    ensureIn(ks, stub.path);
  }

  /** A stub of a store's lieu row: its path walked up its units. */
  function stubOfRow(ks: KeyStore, id: string): LieuStub | null {
    const row = ks.lieux.get(id);
    if (!row) return null;
    const path: string[] = [];
    for (let u: string | null = row.unit; u && u !== WORLD;) {
      path.unshift(u);
      u = ks.units.get(u)?.row?.parent ?? null;
    }
    const { key, unit, lat, lng, city, n } = row;
    return { id, key, unit, path, lat, lng, city, n };
  }

  /**
   * An audition was created: every store goes, and the key asked for last is
   * asked again, as a new key is — its scope's chain in one request, swapped
   * in once it is held; the tree on screen stays meanwhile, never asked for
   * again. The place picker's is asked again if it was wanted (the one before
   * read meanwhile). A reload while the last one is on its way starts over.
   */
  function refresh() {
    const current = next ?? shown;
    if (!current) return;
    const req: TreeRequest = { key: current.req.key, params: current.req.params };
    const picker = stores.get(EMPTY_KEY);
    if (picker?.units.get(WORLD)?.loaded) staleEmpty = picker;
    const pickerWanted = !!picker && req.key !== EMPTY_KEY;
    // On the lazy path, the places opened in the picker come back with its
    // reload (the tree before read until they are in): the picks' labels and
    // ancestors with them. A whole tree comes back whole.
    const reopen = pickerWanted && staleEmpty && !staleEmpty.complete ? [...pickerOpened] : [];
    const stubs = shown?.req.key === req.key ? [...shown.stubs.values()] : [];
    for (const ks of [...stores.values()]) {
      if (ks !== shown) {
        drop(ks);
        continue;
      }
      // On screen until its reload is: kept for its key's parameters, its
      // requests and retries let go, its answers out of the query cache (one
      // that came during a reload may predate this one's audition).
      ks.stale = true;
      abandon(ks);
      queryClient.removeQueries({ queryKey: [...placesKeys.all, ks.req.key] });
    }
    next = null;
    // Its reload holds the lieux opened from a list before it is asked.
    if (stubs.length) {
      const reload = storeOf(req);
      for (const stub of stubs) reload.stubs.set(stub.id, stub);
    }
    refreshes++;
    request(req);
    if (pickerWanted) wantEmpty();
    if (reopen.length) {
      // In the world's request.
      const ks = emptyStore();
      ensureIn(ks, reopen, true, true);
      bumpFor(ks);
    }
  }

  // reloadPlaces (the lists' queries are asked again by their observers).
  const unsubscribe = onPlacesReload(() => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, REFRESH_MS);
  });
  if (getCurrentScope()) {
    onScopeDispose(() => {
      unsubscribe();
      window.clearTimeout(refreshTimer);
    });
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

  /** A kept key's parameters (null once its store is dropped). */
  function paramsOf(key: string): Readonly<Record<string, string>> | null {
    return stores.get(key)?.req.params ?? null;
  }

  /** The world's answer on screen: N résultats = self.n + unplaced.n. */
  function root(): PlaceCounts | null {
    void version.value;
    return shown?.root ?? null;
  }

  /** The tree on screen is whole (its world answer was complete). */
  function complete(): boolean {
    void version.value;
    return shown?.complete ?? false;
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
   *  once wanted (the one before a reload until its own reload is in);
   *  read after both versions. */
  function emptyData(): UnitTreeData | null {
    void version.value;
    void sideVersion.value;
    if (staleEmpty) return staleEmpty;
    const ks = stores.get(EMPTY_KEY);
    return ks?.units.get(WORLD)?.loaded ? ks : null;
  }

  /** The place picker's reload replaces the store before once it holds the
   *  world and the places opened before (or they failed, or were let go). */
  function settleEmpty(ks: KeyStore) {
    if (!staleEmpty || ks.req.key !== EMPTY_KEY || !ks.units.get(WORLD)?.loaded) return;
    for (const id of pickerOpened) {
      if (!ks.units.get(id)?.own && (ks.inflight.has(id) || ks.waiting.has(id))) return;
    }
    staleEmpty = null;
  }
  function wantEmpty() {
    const ks = emptyStore();
    // Wanted again: a failed answer is asked for again.
    if (forgetFailures(ks)) bumpFor(ks);
    ensureIn(ks, [WORLD], true);
  }

  /** The place picker's store asked for now (a reloaded one's reload). */
  function emptyStore(): KeyStore {
    const known = stores.get(EMPTY_KEY);
    return known && !known.stale ? known : storeOf({ key: EMPTY_KEY, params: {} });
  }

  /** What a change of a store's loading or failures bumps. */
  function bumpFor(ks: KeyStore) {
    if (ks === shown || ks === next) status.value++;
    else sideVersion.value++;
  }

  /**
   * The place picker's tree on the lazy path: these units' children asked
   * for (a node opened), their own answers, batched and retried as the map's
   * are; what failed under them is asked for again. A unit already known
   * (always, when the world's answer was the whole tree) asks for nothing.
   */
  function loadEmpty(ids: readonly string[]) {
    const ks = emptyStore();
    pickerIdle = false;
    for (const id of ids) {
      if (!ks.units.get(id)?.own) pickerOpened.add(id);
      ks.failed.delete(id);
      ks.attempts.delete(id);
    }
    ensureIn(ks, ids, false, true);
    bumpFor(ks);
  }

  /** The filter dialog opened: the places opened in the picker are wanted
   *  again, so a read still on its way since it closed is retried after its
   *  wait, not let go and asked again at once. */
  function openEmpty() {
    pickerIdle = false;
    wantEmpty();
  }

  /** The filter dialog closed: the place picker's reads of opened places
   *  waiting to be asked again are let go (asked again when opened again; a
   *  read on its way is not retried). */
  function idleEmpty() {
    pickerIdle = true;
    const ks = stores.get(EMPTY_KEY);
    if (!ks) return;
    let changed = false;
    for (const id of [...ks.waiting]) {
      if (wanted(ks, id)) continue;
      window.clearTimeout(ks.timers.get(id));
      ks.timers.delete(id);
      ks.waiting.delete(id);
      ks.attempts.delete(id);
      changed = true;
    }
    if (!changed) return;
    settleEmpty(ks);
    bumpFor(ks);
  }

  /** Where a unit of the place picker's tree stands: its answer on its way
   *  (or waiting to be asked again), failed, or neither. */
  function emptyStatus(id: string): "loading" | "failed" | null {
    void version.value;
    void sideVersion.value;
    void status.value;
    const ks = stores.get(EMPTY_KEY);
    if (!ks) return null;
    if (ks.inflight.has(id) || ks.waiting.has(id)) return "loading";
    return ks.failed.has(id) ? "failed" : null;
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
      stubs: shown ? [...shown.stubs.keys()] : [],
      complete: shown?.complete ?? null,
      stale: shown?.stale ?? false,
      refreshes,
      unitsAsked: [...stores.values()].reduce((s, ks) => s + ks.asked, 0),
      requests: batcher.sent(),
      inflight: [...stores.values()].reduce((s, ks) => s + ks.inflight.size, 0),
      waiting: [...stores.values()].reduce((s, ks) => s + ks.waiting.size, 0),
      failed: shown ? [...shown.failed] : [],
      failedNext: next ? [...next.failed] : [],
      picker: pickerStats(),
    };
  }

  function pickerStats() {
    const ks = stores.get(EMPTY_KEY);
    if (!ks) return null;
    return {
      units: ks.units.size,
      loaded: [...ks.units.values()].filter((e) => e.loaded).length,
      lieux: ks.lieux.size,
      complete: ks.complete,
      asked: ks.asked,
      opened: pickerOpened.size,
      idle: pickerIdle,
      stale: staleEmpty !== null,
      inflight: [...ks.inflight.keys()],
      waiting: [...ks.waiting],
      failed: [...ks.failed],
    };
  }

  return {
    version,
    status,
    sideVersion,
    request,
    setScope,
    ensure,
    addStub,
    setCarry,
    data,
    shownKey,
    wantedKey,
    paramsOf,
    root,
    complete,
    loading,
    failed,
    facts,
    emptyData,
    wantEmpty,
    loadEmpty,
    openEmpty,
    idleEmpty,
    emptyStatus,
    stats,
  };
}

export type UnitTree = ReturnType<typeof useUnitTree>;
