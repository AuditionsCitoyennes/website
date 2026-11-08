# API optimisation audit — 2026-10-20

> **Note (2026-11-08):** `/api/boundaries`, its module and the vendored france-geojson were removed in #176; the web reads the static outline files (docs/map-outlines.md).

> **Note (2026-11-08):** the API's DEM renderer (`modules/dem`, `/api/dem`) was removed in #177; the plateau relief is rendered in the browser (#147, the default since #173).

Scope: `apps/api` (29 files, ~4 000 lines), the migrations it depends on, and the web client calls that drive it. Method: 9 finders (one lens each), 3 adversarial reviewers per finding (correctness, impact, safety), kept only with 2-of-3; the DB/RPC lens was not reviewed and is marked as my own judgement. Measurements were taken on the dev API (`localhost:3000`, Supabase eu-north) on 2026-10-20. Line numbers are those of the working tree that day; `services/boundaries.ts` and `services/dem.ts` changed under the audit (your WIP), so those two are referenced by function name.

## What the numbers say

| Endpoint | Raw | Gzip | Cold | Warm | Headers |
|---|---|---|---|---|---|
| `GET /api/testimonies` (1 983 rows, 94 auditions) | 4.75 MB | 1.56 MB | 1.65 s | 80 ms | no ETag, no Cache-Control |
| `GET /api/map` (50 groups) | 57 KB | 7.4 KB | 1.08 s | 2 ms | none |
| `GET /api/auditions` (94) | — | 6 KB | 124 ms | 1 ms | none |
| `GET /api/imported-auditions/map` (1 099) | 646 KB | 128 KB | 650 ms | 12 ms | none |
| `GET /api/boundaries/departements` | 585 KB | 238 KB | 20 ms | 16 ms | none |
| `GET /api/boundaries/communes` (29 precise, uncached) | — | — | 12.8 s | — | none |
| DEM tile, 6 553-vertex selection | 760 B | — | 4–12 ms | 1.5 ms | max-age=3600 |

Upstream, one Supabase round-trip from the API host costs 170–250 ms (GoTrue `getUser` 190 ms, `rpc is_admin` 170 ms, auditions select with count embed 250 ms, a 1 000-row testimonies page 300–650 ms). An admin mutation therefore spends ~800 ms in sequential hops before any email is sent.

The warm 80 ms on `/api/testimonies` is pure waste: the cached array is re-stringified (15–27 ms) and re-gzipped (~60 ms) on every request, and a returning visitor downloads the same 1.5 MB again because nothing lets the browser revalidate. The home page triggers that download for a preview card that never reads it.

## Roadmap (PR-sized, in value-for-effort order)

### PR 1 — Bytes on the hot path (S/M)

1. **Cache the response, not the value.** Add `cachedResponse(key, ttl, fn)` beside `cached()` in `cache.ts`: once per fill (inside the single-flight) build `{ json: Buffer, gz: Buffer, etag }` with `await promisify(zlib.gzip)` (async, never `gzipSync` on a 4.75 MB body; skip brotli q11). Routes: `If-None-Match` → 304; else `ETag` + `Vary: Accept-Encoding` + pre-gzipped Buffer with `Content-Encoding: gzip` (`@fastify/compress` leaves replies that already carry an encoding alone). Keep the same `PUBLIC_CACHE_KEYS` so `invalidatePublicCaches()` still drops it. Hash the JSON, not `generation+expires` (that would rotate the tag every TTL).
   - Apply to `/api/testimonies`, `/api/map`, `/api/auditions`, `/api/imported-auditions/map`, `/api/boundaries/{metropole,regions,departements}` and `/departement/:code`.
   - `Cache-Control: no-cache` on map/testimonies/auditions (the Témoignages poll compares group counts across polls, so a browser-cached copy would freeze it); `public, max-age=86400` on boundaries levels; `max-age=300` on imported.
   - Expected: hot `/api/testimonies` 80 ms → <1 ms; every map poll and every reload → a bodiless 304; `/api/boundaries/departements` stops costing 16 ms of gzip per page load.
2. **Stop the landing page from pulling the corpus.** `apps/web/src/pages/Temoignages.vue:24-31`: `enabled: computed(() => !props.preview)` on the testimonies query, and short-circuit `filteredOwnGroups`/`resultCount` while `props.preview`. Saves 1.5 MB and ~80 ms server CPU per home-page visit. Frontend change, but it is the single largest avoidable transfer on the site.
3. **DEM tiles are content-addressed.** `routes/dem.ts`: `Cache-Control: public, max-age=31536000, immutable` — but first fold a `RENDER_REV` constant into the version hash in `setSelection` (otherwise an encoding change leaves returning clients on year-old tiles) and widen the key beyond 32-bit fnv1a.
4. **Trim the map rows.** Add `MapAudition = Pick<Audition,'id'|'title'|'date'|'location'> & { testimony_count }` in `@ac/shared`, project in `buildLocationGroups` (not by changing the shared `fetchPublishedAuditions` select, which `/api/auditions` and the warm pass also use). Drops `content`, `place`, `created_by` (a user UUID exposed publicly), `updated_at`. Saving is ~2.6 KB gz per poll; the privacy point is the real reason.

### PR 2 — Cache correctness (S)

1. **Race: a write during an in-flight fill is lost for a full TTL.** `cache.ts:22-41` stores whatever `fn()` returns even if `invalidate()` ran meanwhile. Fix: per-key epoch — capture before `fn()`, `store.set` only if unchanged; `invalidate()` bumps the epoch, deletes the entry and drops the in-flight promise (with ownership-checked cleanup in `finally` so an old fill cannot delete the newer promise). ~15 lines. Then delete the first `invalidatePublicCaches()` in `POST /api/auditions` (`routes/auditions.ts:151`), which only opens a window where the audition is public with 0 testimonies.
2. **Stale-while-revalidate on natural expiry only.** `{ value, fresh, stale }`: between `fresh` and `stale` serve the stored value and start one background refill; on refill failure keep serving the last good value with a short backoff (5 s doubling to 60 s) and log once. `invalidate()` stays a hard delete (documented invariant: a write must surface). Prewarm the public and imported keys at boot. Today the unlucky visitor after each 60 s pays the 1.65 s refill, and a Supabase hiccup turns every poll into a 500 although a good copy is in memory.
3. **One auditions pull for three consumers.** `buildLocationGroups` (`services/locations.ts:70`) calls `fetchPublishedAuditions()` directly, bypassing the `auditions:published` key that `/api/auditions` and the warm pass share. Read through `cached(PUBLIC_CACHE_KEYS.auditions, …)` and derive groups synchronously; `await loadGeocodeCache()` first (today the first `/api/map` after boot can be built from an empty geocode cache and cached for 15 s with pins missing).
4. **Invalidate after the write, before anything slow.** `DELETE /api/auditions/:id` returns on error at `routes/auditions.ts:369` *before* invalidating at `:370`, after the testimonies are already gone; `PATCH` waits up to 3 s in `geocodeBriefly` before invalidating. Hoist the invalidation to right after each successful write.
5. **`/api/auditions/:id`** is the only uncached public read and 500s on a malformed id: add the `z.string().uuid()` guard (as `admin.ts:165`) and `cached('audition:'+id, 60_000, …)` with a bounded per-id map cleared by `invalidatePublicCaches()`.

### PR 3 — Nothing may hang (S)

1. **Timeouts on the seven bare fetches.** `geocode.ts:125,154` (BAN, 5 s), `services/boundaries.ts` commune fetch (8 s), level files and the per-département bulk fetch (20–30 s), `services/analysis.ts:71` (Anthropic, 30–60 s). Only `places.ts` and `emails.ts` have one today. A BAN call that never answers wedges the serial throttle chain (`geocode.ts:79-100`) for the life of the process: the warm pass stays "running" forever, every `/api/map` hit returns early, the admin list's background lookups hang.
2. **Negative cache for geocoding.** `lookUp`'s catch (`geocode.ts:304-306`) returns `null` without caching, so one failing lieu makes every `/api/map` hit start a new warm pass (`warmLocationGeocodes` never latches because `pending > 0`), each issuing BAN calls and then `invalidate(map)` — re-creating per-poll upstream traffic. In-memory `backoff: Map<name,{until,tries}>` with exponential backoff (never persisted), `resolve()` returns `null` without a throttle slot while backing off, and `resolvedAny` only when the cache actually changed.
3. **Communes: reuse the bulk path you already wrote.** `getCommunes` fetches one commune per Géo API call, six at a time, serial batches, no negative cache (a dead INSEE code 404s upstream on every pan). `getDepartement` already pulls a whole département's contours in one request: factor that into a single-flighted `fetchDepartementCommunes(dep)` that seeds `commune:<code>` for every feature, and have `getCommunes` group its misses by département and call it when several are missing. Replace the slice loop with a pool so one slow commune does not hold its five neighbours. Cache 404s for a day.
4. **Online testimony email: retry before rolling back.** `routes/onlineTestimonies.ts:173-198` deletes the testimony on *any* throw, including a 15 s timeout on a send Resend may have already accepted — the visitor then holds a dead link and is told to resubmit. Retry once after ~1 s with the same `Idempotency-Key` (Resend dedups) on `AbortError`/network/5xx; roll back only on a definitive 4xx. Answer retryable failures with 503 + `Retry-After`, not "vérifiez l'adresse".

### PR 4 — Disk caches (M)

1. **Loader race (both files).** `load()` sets `loaded = true` before `await readFile` (`geocode.ts:46-56`, `services/boundaries.ts load()`): the three parallel boundary queries GeoNav fires on mount see an empty map on every cold start and re-download the level files from GitHub, then persist the whole file again. Memoise the promise (`loading ??= readCache()`) and `await` both loaders in `index.ts` before `listen`.
2. **Persistence proportional to the change.** `persist()` re-stringifies the entire 9.5 MB map (46–131 ms on the event loop, measured) every 3 s while someone drills, and writes in place (a crash mid-write leaves a truncated file that `load()` silently ignores → full re-fetch). Keys are immutable once set, so: one file per key under `.cache/boundaries/<key>.json` written tmp+rename (O(1) per insert, no debounce timer to lose on SIGTERM), or an append-only NDJSON journal. Geocode: same atomic write, drop the pretty-print, debounce.
3. **`CACHE_DIR`** in `config.ts` (default `apps/api/.cache`, `mkdir -p` at boot), `.gitignore` → `.cache/`, delete `.geocode-cache.json` and `-v2`. Vendor the three static france-geojson levels into the repo so a cold boot never touches raw.githubusercontent.com. Consider a byte-bounded LRU for communes (the heap is ~50 MB today; growth is bounded by communes that carry testimonies, so this is a safety net, not urgent).
4. Skip for now: a Supabase table for outlines (puts a network hop and egress back on the boundaries path), `node:sqlite`, worker threads for persistence.

### PR 5 — Admin round-trips (S/M)

1. **`getClaims` instead of `getUser`.** `auth.ts:31`: `adminClient.auth.getClaims(token)` verifies locally against a cached JWKS when the project uses asymmetric signing keys (check Dashboard → Auth → JWT Signing Keys; it falls back to `getUser` on HS256). Build `req.user` from `sub`/`email`/`user_metadata`, the only fields read. Revocation is then bounded by `exp` (≤ 1 h), acceptable for an admin UI.
2. **One roles read, memoised.** Replace the `is_admin` + `is_super_admin` RPC pair (`auth.ts:42-48`) with one `user_roles` select (via `adminClient`, or RLS-scoped — the existing policy returns an empty set for non-admins), memoised per user id for 60 s and invalidated from the two role-writing routes in `admin.ts`. Make `requireSuperAdmin` share it.
3. **`clientForToken`** (`supabase.ts:30-35`): use `createClient(url, anon, { accessToken: async () => token })` — supabase-js then skips building a GoTrue client per request and stops awaiting `auth.getSession()` before every query.
4. Per-route waste: `POST /api/testimonies` reads the same audition row twice (`routes/testimonies.ts:106-110`, `139-143`) — one `select("audition_en_ligne, title, location, date")` before the insert; `DELETE /api/admin/roles/:id` loads every role to find one — one `delete().eq(id).neq("role","super_admin").select(...)`; `DELETE /api/me` deletes `user_roles` that the FK already cascades (`me.ts:32`).
5. **Stop echoing `verification_token` to the admin browser.** `PATCH` pre-reads with `select("*")`, updates with `.select()` and returns the row; `/for-audition` also sends `*`. One `ADMIN_TESTIMONY_COLUMNS` constant without the token.
6. `cors: { maxAge: 7200 }` so admin mutations stop paying a preflight each; `credentials: true` is unused (Bearer only).

### PR 6 — Ops hardening (S/M)

1. **Fail closed on mode.** `"start": "tsx src/index.ts"` sets no `NODE_ENV`, and `isDev = NODE_ENV !== "production"`. Consequence in `routes/onlineTestimonies.ts:85`: a production box whose `RESEND_API_KEY` is missing or rotated answers the anonymous form with `devVerificationUrl` — anyone can publish a testimony under any address. Make `isDev = NODE_ENV === "development"`, one source of truth in `config.ts`, and set it in the `dev` and `start` scripts (or make the dev link an explicit `EMAIL_MODE=log` opt-in).
2. **Graceful shutdown.** `process.once('SIGTERM'|'SIGINT')` → 10 s watchdog, `app.close()`, flush the disk caches in an `onClose` hook, exit. Today a deploy cuts in-flight requests and loses the debounced persist (its timer is `unref`'d).
3. **One error handler.** Every route returns raw PostgREST/upstream text (`reply.internalServerError(error.message)`, ~40 sites) and `lib/api.ts:41` shows it verbatim; boundaries routes turn *any* failure (GitHub 5xx, timeout) into a 404 the client treats as definitive. `app.setErrorHandler`: pass through anything with a 4xx `statusCode` (sensible, zod, Fastify parser errors), log and reply a generic French 500 with `req.id` otherwise. Then delete the per-route try/catch.
4. Logger: `LOG_LEVEL`, `redact: ['req.headers.authorization']`, `disableRequestLogging` + an `onResponse` hook that logs only ≥400 or >500 ms (the 2.5 s poll and tile bursts currently write two lines each); `requestIdHeader: 'x-request-id'`; `pino-pretty` in dev.
5. `requestTimeout: 30_000`, `keepAliveTimeout` above the proxy's idle timeout. `bodyLimit`: `.max(20000)` on `content` in the shared schemas (verify already enforces it), `.max(200)` on inline testimonies; `/api/dem` its own limit and a vertex cap.
6. Build: `engines`/`.nvmrc` (CI pins Node 20, you run 22), esbuild bundle → `node dist/index.js`, dotenv only outside production, Dockerfile with `STOPSIGNAL SIGTERM` — this is the already-planned containerisation phase.

### PR 7 — Database (one migration each, through the scratch-workdir procedure; my judgement, not adversarially reviewed)

1. **RLS functions evaluated per row.** The 2025-12 policies call `is_admin()`/`is_super_admin()` bare (SECURITY DEFINER blocks inlining → two index probes per candidate row, ~4 000 per anon scan); the 2026-10 migration already wraps its own as `(select public.is_admin())`. Re-create the four testimonies and two user_roles policies with sub-selects (same predicates, InitPlan once per statement). Cheap, benefits every query including the old app's. Verify with `explain (analyze)` as `anon`.
2. **Indexes:** `audit_log(created_at desc)` (the only one that compounds), `testimonies(created_at desc, id desc)`, `auditions(date desc) where status='published'`, `testimonies(audition_id) where verification_status='verified'`. Without `concurrently` (the migration runs in one transaction); trivial at this size.
3. **Optional, after PR 1 lands:** a `public_testimonies_json()` SECURITY DEFINER RPC returning `jsonb` with the same visibility predicate the two existing views use — one round-trip instead of 2–3 pages, no per-row RLS, no 1 000-row cap. Same for the map rows with counts from `audition_testimony_counts`. Expose "warm pass complete" (`warmGeneration === publicCachesGeneration()`) as a header so the client stops polling at once instead of after 3 stable ticks.
4. **Optional:** `verify_testimony_v2(p_token, p_action, p_edits)` collapsing the 3–5 sequential calls of `POST /api/verify/:token` into one transaction with `PT404/409/410` errcodes (the pattern `submit_online_testimony` already uses). Keep the old function; the DB is shared with the old app.
5. Not recommended now: audit-log triggers (`drop_emptied_audition` also fires for the old app and for housekeeping, so trigger-side logging would change what the log means), the custom access token hook (invasive; revocation semantics), direct `pg` through Supavisor (saves the PostgREST hop only; adds a pool to own).

### PR 8 — Structure, after the WIP lands (M)

- `lib/postgrest.ts: fetchAll(page, size)` for the three copy-pasted 1 000-row loops (`routes/testimonies.ts:26-43`, `:59-72`, `services/importedAuditions.ts:66-93`), first page with `count: 'exact'`, remaining pages in parallel.
- `lib/errors.ts: HttpError` + the single error handler above; `app.requireAdmin`/`requireSuperAdmin` as per-route preHandlers (not plugin-wide: `GET /admin/roles` must stay reachable); zod body validation via a validator compiler so the seven identical `safeParse` prologues go.
- `lib/persistedMap.ts` shared by `geocode.ts` and `boundaries.ts` (memoised load, atomic write, `flush()`).
- `emails.ts`: express `buildVerificationHtml` through `wrapBrandedEmail` (the chrome is identical), one `button()`/`send()` helper, route single recipients through `/emails` with an idempotency key (the batch path has none, so a timed-out retry can double-send).
- `AdminArea` type in `@ac/shared` and one `areaOf*` module; the area shape is assembled four ways today with two field namings (`depCode` vs `departementCode`).
- Regenerate `database.types.ts` (three `as never` casts, an untyped client for `imported_auditions`, `p_user_id` typed non-null); delete `geocode()`, the two unused shared schemas, the two stale cache files.
- Keep the existing `routes/` + `services/` layout; no `routes/public` vs `routes/admin` split, no `db/`/`plugins/` directories.

## Dropped after review

- "places.ts cache keyed by untrusted INSEE": the body schema already enforces the exact regex before `resolveTownHall`.
- "DEM rasteriser is O(scanlines × all edges) with no culling": the current `rasterizeMask` already drops edges outside the tile's row band; measured bursts are ~0.2 s wall with ≤ 87 ms event-loop latency. Keep only the cheap bbox cull + shared constant ground/plateau tiles (output-identical); no worker pool, no active-edge table.
- "Boundaries memory grows to 2 GB": growth is bounded by communes that carry testimonies, not by viewports. A cap is a safety net, not a fix.
- "CORS needs multiple origins": contradicts the agreed deployment (SPA behind a same-origin `/api` proxy).
- Rate limiting the Anthropic route: both bulk callers are already sequential; a cap would throttle the legitimate "analyser tout" loop. Keep only a timeout and one retry honouring `retry-after`.
- A response schema (fast-json-stringify) for `/api/testimonies`: moot once the body is pre-serialised.
- Stale-on-`invalidate()`: must stay a hard delete; the frontend and the warm pass rely on it.
