# Map roadmap phase 1: server-side place data — design (2026-10-26)

> Implements phase 1 of [the map roadmap](map-roadmap-2026-10-25.md). Written from a read-only reconnaissance of the code, three independent drafts, a judge panel and two rounds of adversarial review.

> **Citations.** Repo `dev` @ 4adbcd5. File:line citations point into that tree unless a prefix says otherwise:
> - `OLD:` the live React app, `/Users/dranak/Documents/Projects/AuditionsCitoyennes_Website/src`
> - `WT:` PR #110's worktree, `.claude/worktrees/interesting-spence-53b0c8`
> - `B:` `supabase/migrations/20261021175021_baseline.sql`
> - `M7:` `supabase/migrations/20261024234316_rls_initplans_and_indexes.sql`
>
> **Where this design comes from.**
> - *Base:* the delivery draft (Draft 3), which the judges ranked best.
> - *Grafted from the parity draft (Draft 1):* the newest-date ("rank") tie-break; the frozen-client parity harness; the generated columns `place_stale` and `lieu_id`; `placement_support()`; `through=` paging; the `empty` flag; byte-budgeted caches with generation counters; the fallback for new INSEE codes; the tile spot-check.
> - *Grafted from the scale draft (Draft 2):* the covering facts index; the DB gate and 57014 handling; rate limits on cache misses; the heap cap and the boundaries LRU; the non-exposed `ac` schema; CI grant assertions and the migrate-on-seeded-data step; the `polygon` flag; "DB PRs reach staging before their callers merge".
> - *Revision 2* applies the 37 verified issues of review round 2. They are listed in §0.3 with where each is fixed.

---

## 0. Summary

### How it ships

Phase 1 ships as 17 PRs (A–Q), stacked on `dev` and squash-merged one at a time.

**Production database.** Only four PRs touch it: B, C, E and G. Each one only adds things:
- nullable columns;
- a trigger that never raises;
- objects anon and authenticated cannot see;
- a 5 s `statement_timeout` on `service_role` (G);
- a reviewed data backfill (E).

**Everything else** runs only on staging, behind an API env switch or a web dev switch, until it is shown to give today's answers. Four checks prove that:
1. **TS vs SQL in CI.** Every derived testimony value is compared with `@ac/shared`, over the seed plus an edge corpus (PR B).
2. **Frozen client pipeline vs RPCs in CI.** A frozen copy of today's client pipeline, the admin list filter included, runs against the read RPCs over the seeded DB (PR G).
3. **`MAP_SOURCE=db|geocoder` diff on staging.** `/api/map` and the admin list are built both ways and compared (PR D).
4. **An in-page "comparer" data source.** It runs today's corpus pipeline and the server pipeline side by side and lists every difference (PR J).

**France never waits on PR #110.** French units are resolved at write time from geo.api.gouv.fr, which the API already calls (`apps/api/src/modules/online-testimonies/townHall.ts:71-99`). PR #110 gates only three things: the world gazetteer, the non-French picker (M, N), and the world slice of the big seed.

**Parity at production size by construction.** When a subtree holds at most 600 units plus lieux, the counts endpoint returns all of it at once (`complete: true`). That one response then carries:
- every unit's analyses figures;
- every lieu's audition list;
- every lieu's city.

At prod's ~64 auditions the root response is the whole tree. After it, the drill, scope, camera, pins, the open lieu's list and the analyses are synchronous, as today.

What becomes asynchronous even at prod size (all listed in A21):
- every filter change: one round trip, and the previous tree stays on screen meanwhile (D6);
- an opened audition's testimonies (D10);
- result pages beyond the first (D10).

The lazy path runs only on the 300k staging set, or locally with `?budget=0`.

### Core choices

| Topic | Choice |
|---|---|
| Where places live | On `auditions` only: the leaf `place_unit`, the root-first `place_path`, `locality_id`, `lieu_key`, the point, the precision, homonym candidates, the rules hash and a staleness marker. A small `geo_units` dictionary holds only the units that rows reference. |
| Ids | ISO alpha-2 for countries; `fr:reg:` / `fr:dep:` / `fr:com:<INSEE>` for France; Overture GERS ids elsewhere. These are PR #110's tile ids. |
| Old-app writes | An exception-safe trigger keeps the testimony-derived values. For audition placement, a generated staleness column flags the row and an API re-placement job places it. |
| Explicit picks | An admin's BAN pick or a gazetteer pick places that audition. Reusing an existing placement for the same lieu name applies only to text-only placements. |
| Search | Today's accent- and case-folded substring match, on a trigger-maintained `search_text` with a trigram GIN index. |
| Reads | Service-role-only plpgsql RPCs with dynamic SQL, each returning one jsonb. A batched `units=` form serves several units per request. The API caches per unit in byte-bounded families. |
| Unit metadata for the map | Carried in the counts response from the DB. Bboxes are built from lieu points exactly as today. No map gazetteer in phase 1. |
| Gazetteer | The world minus France, as static chunks plus a per-country search index, for the non-French picker. Built on the laptop, published as a GitHub Release, copied into Workers static assets and the API image. |

### 0.1 Facts verified

**On the local stack (2026-10-26, rolled-back transactions).**

- **Role settings.**
  - `postgres` is not a superuser, yet `alter role service_role set statement_timeout = …` succeeds (supautils allows it).
  - Today `service_role` has no `rolconfig`. `authenticator` has `statement_timeout=8s, lock_timeout=8s`; `anon` has 3 s; `authenticated` has 8 s.
  - So a service-role call through PostgREST inherits authenticator's 8 s, unless `service_role` sets its own value.
- **ICU folding matches the browser.**
  - The database has `datlocprovider = icu`, and the `und-x-icu` collation exists.
  - `lower(regexp_replace(normalize(p, NFD), '[̀-ͯ]', '', 'g') collate "und-x-icu")`, inside a function with `search_path = ''`, returns exactly what JS `fold` returns. Tested on Œ, the Kelvin sign, İ, the Greek final sigma and Ǆ.
  - Write `normalize` unqualified: the `pg_catalog.`-qualified call with a bare NFD does not compile.
- **Extensions.** `pg_trgm` and `unaccent` are available but not installed.
- **Service role in the old app.** `OLD: supabase/functions/handle-registration/index.ts:130` uses the service-role key. It is the only prod user of `service_role`.
- **Testimonies without an audition** are already left out of "N résultats" (`apps/web/src/features/temoignages/useTestimonyFiltering.ts:63`). They are still counted in the theme facet (`:108`).
- **Old-app saves.**
  - They normalise the location: `OLD: pages/Admin.tsx:336` on insert, `:482` on update.
  - They send no other place field (`:334-341`, `:476-486`).
  - They can edit online auditions.

**From review round 2 (throwaway PG 17 stack).**
- `on update cascade` on `geo_units` cannot implement a remap. Renaming a leaf violates the immediate CHECK `auditions_place_path`. Inserting the new id first and then renaming violates the primary key.
- Postgres' default EXECUTE to PUBLIC applies to new functions in schema `ac`. `has_function_privilege('anon', …)` is true even without USAGE on the schema. The baseline's default privileges cover `public` only (`B:1329-1352`).
- Eight baseline SECURITY DEFINER functions have no `search_path`: `get_audit_log`, `get_pending_registrations`, `get_user_roles_with_details`, `has_role`, `insert_audit_log`, `is_admin`, `is_super_admin`, `verify_testimony` (`B:178,208,236,275,302,315,339,499`).
- `set local role anon; select count(*) from testimonies` over 300k rows, 70k of them unverified online, takes 32 s. The cause is the RESTRICTIVE policy at `B:904`, which compares every row against `online_testimony_ids(true)`.
- `auditions.date` is NOT NULL (`B:598`), so "newest first" has no NULL case.

### 0.2 Round-1 judge findings, verified and fixed

| Finding | Fix in this design |
|---|---|
| Draft 3's world `self` included unplaced rows, so `resultCount = self + unplaced` double-counted them. | `self` is always computed over placed rows; `unplaced` is reported separately (B5). |
| Counts read the heap at 300k. | Covering index `testimonies_audition_facts_idx` with INCLUDE (B2). |
| The `geo_units` FK had no ON UPDATE CASCADE, yet the remap updates ids. | **Superseded in revision 2.** There is no cascade, and the remap never renames an id. It inserts the new unit, repoints rows explicitly, then deletes the old one (C7). |
| Cache families evicted through `invalidate()`, whose `epochs` map never shrinks (`apps/api/src/lib/cache.ts:74,198-204`). | Separate family stores, bounded in bytes, each invalidated by one generation counter (D3). |
| `~*` depends on the database ctype, and `dol[eé]ances` is too broad. | `lower(… collate "und-x-icu")` with the exact `doléances` (B5, `ac.cohort`). |
| Several line citations were wrong. | COM refusal is `townHall.ts:153-155`; the tiles mkdir is `WT:scripts/map-data/build-boundaries.sh:115`; OVERSEAS is `:98-99`. |
| G's parity test needs placed seed rows, but G did not depend on F. | G depends on B, C and F. |
| The API's abort does not cancel a Postgres query, and a function-level `SET statement_timeout` does not bound the call. | A role-level `service_role` timeout below the API's abort (A11). |
| Point-only localities had no phase-2 tile target. | A `polygon` flag; phase 2 lights the nearest polygon ancestor (C6). |
| The load test depended on PR #110. | The big seed is France-first (F2). |
| Generated columns that call custom functions are EXECUTE-checked against the writing role. | No generated column calls a custom function. The derived values come from a SECURITY DEFINER trigger (B7 proves this as `authenticated`). |
| `pg_catalog.normalize(s, nfd)` fails to compile. | Unqualified `normalize(p, NFD)`. |
| Wrong testimony order and wrong `resultBounds` port in Draft 2. | `coalesce(created_at, '-infinity') asc, id desc`; the exact floor(0.03 n) cut (B5). |
| Draft 2's 30-testimony cap on `/api/auditions/:id` was an unlisted visible change. | Not done. |
| A backfill that aborts would block a prod push. | Rows changed since the review are skipped and left stale (B4). |
| `language sql` catch-all predicates are planned generically. | plpgsql with `EXECUTE … USING` of only the active predicates (B5). |
| Draft 1's RPCs were executable by anon. | Every read RPC is `service_role` only (A11). |
| Polygon bboxes change today's framing before geometry loads. | Bboxes come from lieu points padded by 0.012° (A12). |
| Draft 2 made word search the default. | Substring search stays (A9). |

### 0.3 Review round 2: 37 issues, all verified in code

| # | Issue | Fix |
|---|---|---|
| 1, 34 | The remap through `on update cascade` breaks the CHECK or the PK. It also leaves `citycode` and `place_path` behind and changes `lieu_id` silently. | No cascade. The remap repoints `place_unit`, `place_path`, `locality_id`, `citycode` and children explicitly, then deletes the old unit. The ISO match is limited to regions. A `lieu_id` change on remap is documented (A2, A3, C7). |
| 2, 15 | The admin RPC could not reproduce `textInAudition` or the admin theme facet. | New `admin_audition_filter` returns `[n_all, n_no_text]` per audition plus reachable theme counts; the client combines them with `textInAudition` as today. `/admin/filterable` stays until Q (A22, B5.6, L). |
| 3 | The search_path guard fails on 8 baseline functions. | The guard applies to new functions; the 8 are allowlisted; no hardening in phase 1 (B7). |
| 4 | New `ac.*` functions get EXECUTE for PUBLIC. | Default privileges in schema `ac`, plus a revoke/grant block at the end of every migration that adds `ac` functions (B1, B2). |
| 5, 35 | Step 5 of the CI checks contradicts M3. The F1 edge places are missing from the seed. | Step 5 asserts "placed exactly as M3 lists, all others stale". Serres, Ribiers and "France" are added to the seed (B7, F1). |
| 6 | The backfill gave online rows the reviewed key, not their own `location`. | `lieu_key = case when v.online then a.location else v.key end` (B4). |
| 7 | `geo_units` is unreadable through the public and caller clients. | D6 reads `geo_units` through `adminClient`, and falls back to the geocoder without a service key (D6). |
| 8 | The `/api/testimonies` guard as anon times out at 300k. | It counts through `adminClient` (head, exact); errors and 57014 → 503 (D8). |
| 9 | Reuse dropped `place_candidates`, so reused homonyms counted as support. | Reuse copies `place_candidates` (A6). |
| 10 | `LOCATION_RULES` changes never reached stored rows. | `placed_rules` hash plus a job pass at boot; listed as D14 (A6, A7, D5). |
| 11 | A complete response had facts for countries only. Analyses re-measured on every merge. | Facts for every unit when complete. The Témoignages store always asks for facts. Analyses are memoised by unit id plus a hash of its figures (B5.1, E2). |
| 12 | Paged results reset the scroll and re-fitted the map; the heading counted loaded rows. | The signatures are keyed on (filter key, sort, first page); the heading uses `total` (E1, K). |
| 13 | Opening a lieu and non-text filters became unlisted waits. | Lieu audition lists are embedded when complete. The lazy path gets a loading state (D13). D6 now covers every filter change (A21). |
| 14 | Creating an audition from the dialog no longer refreshed the map. | `placesKeys.all` is invalidated by AppDialogs. The store subscribes to the QueryCache and rebuilds (E2, L). |
| 16 | Result rows had no point or path, and lookups were by canonical name. | Rows carry `lieu{id,key,unit,path,lat,lng,city}`; the store inserts a stub; lookups are by lieu id (B5.3, E1, K). |
| 17 | List mode followed the raw chips while the server key used the debounced needle. | In server mode, list mode follows the debounced effective key, and `results` accepts zero filters (E1, D1). |
| 18 | A filter change on the lazy path sank the plateau and never evicted stores. | The new key loads the current scope chain in one batch, the swap waits for scope and parent, and an LRU keeps 4 stores (E2). |
| 19 | French geometry was returned for non-French units. | Every French geometry source is gated on country `FR` (I, E3). |
| 20, 29 | One ensure per unit plus the miss limits starved the lazy client and the load test. | Batched `units=` (≤ 50, RPC calls of ≤ 20 units); 429 with Retry-After; client backoff; a drill-replay scenario (D1, D4, E2, F3). |
| 21 | The 6 s abort hid 8 s statement timeouts; aborted queries outlived their gate slot. | `service_role` 5 s, abort at 7 s, both → uncached 503; the slot is held 5 s after an abort (A11, D4). |
| 22 | Reuse and LOCATION_RULES overrode explicit picks ("Hebron" → Bron). | An explicit pick skips reuse. Gazetteer picks key on `normalizeLocation` without rules. The job keeps non-French placements (A6, A15, D5). |
| 23 | J's serveur mode had no list data. | In J, `/api/map` and the corpus stay mounted for the lists; K moves the lists (E1, J). |
| 24 | No rule for lieu labels in server mode. | Lieu rows carry `city` (today's group city); labels are compared in parity (B5.1, E2). |
| 25 | The heap cap did not bound Buffers; `/api/auditions` was cached whole. | Heap 256 MB plus one external-memory budget (≤ 112 MB: cache families ≤ 74 MB, external total ≤ 90 MB). `/api/auditions` and `/api/map` get a family and a 5,000-audition guard (A19, D3, D8). |
| 26, 32 | Search and pick validation scanned every region chunk; size estimate wrong. | Per-country search index; picks carry a chunk index; measured sizes; size report (A14, C3, C5). |
| 27 | The staging seed load could not finish. | Spooled per-table COPYs; drop and recreate the big indexes; `statement_timeout = 0`; loaded from the laptop; never `replica` mode; `-U postgres` (F2). |
| 28 | k6 from one IP measured the limiter; CPU share unknown. | Per-VU `X-Visitor-IP`; one single-IP scenario; `cpu_limit` set and reported (F3). |
| 30 | S9 hit the submission ceilings, caused no invalidation, and could mass-delete. | Churn from verify links and admin writes; staging-only limit override; seed has no stale pending rows; a partial index for the housekeeping DELETE (B2, F2, F3). |
| 31 | `/api/auditions` uncapped at 45k auditions broke the deploy check. | Guard plus family in H; deploy check moves to `/api/places/facets`; S11 for `/api/auditions/:id` (D8, F3). |
| 33 | The gazetteer release plumbing did not fit the repo. | Lock file in both `paths:`; `gh release download`; `_headers` appended; HTML treated as skew; ≤ 9,000 files per build; laptop build (C4). |
| 36 | Dependency layer, FR spot-check, dangling parents, and `local_type` was not an enum. | dependency → `country` layer; FR checked against geo_units/Etalab; ancestor closure; filter on `class` (C2, C6). |
| 37 | The G table had no sizes; world-units.json ownership was unclear. | Sizes in G; M creates `world-units.json`, N switches the seed to it (F1, G). |

No issue was rejected. Issue 37 was partly already met: the PR-plan JSON had sizes, but the markdown table did not.

---

## A. Decisions

Each decision gives the choice, why, and the alternatives rejected.

### A1. Place columns live on `auditions`, not on `testimonies`

**Decision.** All place columns go on `auditions`.

**Why.**
- A testimony has no place of its own (`B:619-631`). Every path files it under an audition at insert: `apps/api/src/modules/auditions/service.ts:318-344`, `apps/api/src/modules/testimonies/service.ts:151-167`, `B:452-455`, `scripts/seed/generate.ts:624`.
- Nothing moves a testimony afterwards (`packages/shared/src/schemas.ts:33-39`).
- The old app writes only `location` on auditions (`OLD: pages/Admin.tsx:334-341,476-486`), so staleness is one column comparison.

**Rejected.**
- Columns on `testimonies`, as the roadmap words it (`docs/map-roadmap-2026-10-25.md:94`). The old app resends `location` on every save, so a fan-out trigger would fire constantly.
- Both tables: two copies of one invariant.
- **Escape hatch, built only if the load test proves the join is the bottleneck:** a BEFORE INSERT copy trigger plus an AFTER UPDATE OF `place_path` trigger (B8).

### A2. Unit model: a leaf, a root-first path and a `locality_id` on auditions, plus a `geo_units` dictionary

| Column | Content |
|---|---|
| `place_unit text` | FK to `geo_units(id)`, `on delete restrict`, **no** `on update cascade` |
| `place_path text[]` | Root to leaf inclusive, e.g. `{FR,fr:reg:84,fr:dep:69,fr:com:69123,fr:com:69387}` |
| `locality_id text` | The municipality-level unit. For Paris, Lyon and Marseille it is the commune, as `communeOf` rolls up today (`apps/web/src/features/analyses/stats/scopeStats.ts:169-174`). |

`geo_units(id, parent_id, level, country, name, code, lat, lng, polygon, wikidata, source, geo_release)` holds only units that some audition references: about 15 rows on prod and about 40k at 300k. Ids are **never updated**. A remap inserts the new unit and repoints rows (C7).

**Why.**
- Depth is uneven: France has an arrondissement level, 203k Overture localities nest under localities, and countries skip levels. "Children of P" is one `GROUP BY place_path[k+1]` behind a GIN `@>`.
- The FK guarantees every leaf exists.
- Labels, levels and codes come from one small table, so the map needs no client gazetteer in phase 1 (A12).
- **The path duplicates ancestry.** That is controlled because:
  - only the API, the backfill, the seed and the remap write it, always from a `geo_units` chain;
  - a CHECK ties the last element to `place_unit`;
  - `db:check` asserts every stored path equals the parent chain;
  - the remap rewrites leaf and path in the same UPDATE.
- **Why no cascade.** A cascade rewrites `place_unit` alone, and the immediate CHECK rejects the row before `place_path` can follow. A renamed ancestor would also leave stale ids in `place_path` (verified, §0.1).

**Rejected.**
- Metadata only in static chunks (Draft 2): it puts a client gazetteer on the map's critical path, and France has no chunk.
- Fixed level columns.
- A closure table.
- The whole gazetteer in the DB: more than 600k rows against Free's 500 MB.

### A3. Id formats

| Unit | Id |
|---|---|
| Country | ISO 3166-1 alpha-2, as Overture's `country` attribute (`FR`, `DE`, Overture `X*` codes as given). A dependency is its own root (`WT:build-boundaries.sh:155-158`). |
| France below the country | `fr:reg:<INSEE>`, `fr:dep:<INSEE>` (`2A`, `2B`, `971`…), `fr:com:<INSEE>`, arrondissements municipaux included (`WT:build-boundaries.sh:203,207,211-217`). |
| Elsewhere | The Overture GERS division id, verbatim (`WT:build-boundaries.sh:269`). |
| Lieu | `lieu_id = 'l:' \|\| left(md5(place_unit \|\| chr(31) \|\| lieu_key), 16)`, a generated column. |

**`lieu_id` and remaps.** A remap that moves a leaf changes the `lieu_id` of the lieux under it. Lieu filter tokens are held in memory only: filters are not persisted in URLs or storage (`apps/web/src/features/filters/useFilters.ts`). The remap also bumps every cache generation. A token held across a remap therefore matches nothing until the reader re-picks. This is accepted: French codes move once a year, and non-French localities move about 0.27% a month.

**Rejected.**
- GERS ids for countries.
- ISO 3166-2 for adm1.
- `insee:` prefixes.
- A remap-stable lieu hash built from `lieu_key` alone: two explicit picks with the same name in two communes would collide.

### A4. Paris, Lyon and Marseille

- The arrondissement is a unit below the commune: `fr:com:69387` with parent `fr:com:69123`, `level = 'locality'`, as PR #110 tiles it.
- `place_unit` is the arrondissement; `locality_id` is the commune.
- Arrondissement labels stay "Lyon 7e" (`apps/api/src/modules/geo/match.ts:151`).
- Online buckets keep today's town-hall keys. `SHARED_MAIRIE` maps Paris 1er–4e to 75103 and Marseille to 8 sector halls (`townHall.ts:25-37,149`).

**Rejected.**
- The commune as the leaf.
- Storing the visitor's own arrondissement (founder question 9).

### A5. Overseas France sits under `FR`

- DROM and COM follow Etalab and geo.api: régions `fr:reg:01…06`, then départements and communes.
- A COM is both région and département with one code (`fr:reg:975` → `fr:dep:975`).
- Overture's GP/MQ/GF/RE/YT/PM/BL/MF/WF/PF/NC/TF/CP top-level polygons get `id = 'FR'` in the country layer (M).
- The online form keeps refusing COM (`townHall.ts:153-155`).

**Rejected.** Overseas territories as separate ISO countries.

### A6. Lieu identity is stored on the audition

| Column | Content |
|---|---|
| `lieu_key` | **French text placements:** today's `placeKeyOf()` (`apps/api/src/modules/auditions/service.ts:53-55`), frozen at placement. That is `getCanonicalLocation(location)` (`packages/shared/src/locations.ts:94-101`) for in-person rows and the town-hall label (`location`) for online ones. **Gazetteer picks (abroad):** `normalizeLocation(location)` (`locations.ts:10`), with no `LOCATION_RULES`. |
| `lat`, `lng` | France: the curated rule point (`getKnownCoordinates`, `locations.ts:104-107`), else the explicit BAN pick, else BAN's entry (`apps/api/src/modules/map/locationGroups.ts:84`). Online: the mairie point, else the commune centre (`townHall.ts:156`). Abroad: the locality's label point. |
| `place_precision` | `address \| commune \| locality \| departement \| region \| country \| unplaced` (`packages/shared/src/auditions.ts:64-65`). |
| `place_candidates jsonb` | The homonym candidates, whenever homonyms were involved, settled or not. |
| `placed_rules text` | An 8-hex hash of `LOCATION_RULES` used at placement (A7, D14). |
| `lieu_id` | Generated (A3). |

**Order of placement steps** (`placeLieu`, D5):
1. **Generic text → `unplaced`.**
2. **Explicit pick, if any.** An admin BAN pick or a gazetteer pick places the row at the pick. It never yields to reuse, so an admin can correct a lieu by re-picking (D12).
3. **Reuse, for text-only placements** (old-app rows, the job, an admin who typed without picking). If a placed, non-stale offline row has the same `lieu_key`, copy its unit, path, locality, point, precision **and `place_candidates`**. Copying the candidates keeps a reused homonym out of `placement_support()`, as today: `settleHomonyms` skips homonym entries (`match.ts:447-456`). Today every row with one canonical name shares one geocode-cache entry (`apps/api/src/modules/geo/geocode.ts:37,118-120`). Reuse keeps that even after the disposable BAN cache is gone.
4. **Otherwise, today's pipeline.**

**Homonyms.**
- Settled once by `pickHomonym` (`match.ts:457-469`, thresholds `:98-100`), with support from `placement_support()` (B3).
- A settled homonym never moves (D4).
- An unsettled one stays `unplaced` with its candidates, and the job retries it every 10 minutes with no BAN call.

**Rejected.**
- A SQL port of `getCanonicalLocation`.
- A lieux table.
- A separate display label.

### A7. Old-app audition writes: a DB-maintained staleness marker, a rules pass, and a re-placement job

- `placed_location text` records the `location` a placement was computed from.
- `place_stale boolean GENERATED ALWAYS AS (placed_location IS DISTINCT FROM location) STORED` calls no custom function.
- **What makes a row stale:**
  - an old-app insert, which writes location only;
  - a real change of location, by either app.
- **What does not:** an unchanged resend.
- If the old app re-normalises a location the new API stored differently, the row becomes stale and is re-placed. That direction is safe.
- **Rule changes.** `LOCATION_RULES` live in JS, so staleness from a rule change cannot be computed in SQL. At boot, the job runs a rules pass over placed French offline rows whose `placed_rules` differs from the current hash:
  - if `getCanonicalLocation(location)` or its known point changed, it sets `placed_location = NULL`, which makes the row stale;
  - otherwise it only stamps the new hash.

  So a rule change reaches stored rows on the first job pass after a deploy, instead of at the next read (D14).
- **Non-French rows** (gazetteer picks) going stale after an old-app edit keep their unit and point. The job recomputes only `lieu_key = normalizeLocation(location)`.
- **Online rows** go stale only if the old app renames them. The job recomputes from `citycode` and sets `lieu_key = location`.
- **The job** (D5):
  - replaces the read-time warm pass (`locationGroups.ts:102-172`, `apps/api/src/index.ts:25`) and `geocodeBriefly` (`auditions/service.ts:253-259,349,447`);
  - runs once against prod at cutover, dry run first.

**Rejected.**
- A trigger that nulls the placement: both apps write as `authenticated` (`apps/api/src/lib/supabase.ts:36-39`).
- Geocoding in the DB: there is no `pg_net` on prod.
- No marker at all: there is no `updated_at` trigger (`B:795` is the only trigger).

### A8. Derived testimony values: an exception-safe SECURITY DEFINER trigger

**Columns:** `search_text`, `theme_mask int` (bit i = `AUDITION_THEMES[i]`), `themes_approx`, `untagged`, `derive_version smallint`.

**The trigger:** `ac.testimonies_derive()`, BEFORE INSERT OR UPDATE, on every update. Its helpers are SQL ports generated from `@ac/shared`:
- `fold` (`apps/web/src/features/filters/filters.ts:9-14`, moved to shared);
- `themeKey`, GRID, BY_KEY and `read` (`packages/shared/src/themes.ts:40-48,91-144`);
- `normalize`, `QUESTION_AT`, `parseAnswers` and `answersText` (`packages/shared/src/answers.ts:26-31,64-100`).

On any error it writes NULLs and `derive_version = -1` instead of failing. It covers every writer:
- old-app content and topic edits;
- AI tagging;
- `verify_testimony_by_token` with `p_edits` (`B:539-575`);
- `submit_online_testimony`;
- the seed, CI and the API.

**Why a trigger beats STORED generated columns.**
1. **Exception safety.** A parser bug can never block an old-app write.
2. **Grants.** A generated column's functions are EXECUTE-checked against the writing role. A SECURITY DEFINER trigger lets the helpers stay revoked.
3. **Versioned recompute.** A rule change is a migration that replaces the helpers and runs batched `update … set topics = topics where derive_version is distinct from N`.

**Cost.** One subtransaction per written row, measured during the big COPY (F2).

### A9. Search semantics: exactly today's

- **The match.** `fold(person_name + ' ' + (person_info ?? '') + ' ' + answersText(content))` contains `fold(text.trim())` as a substring (`filters.ts:63-66`, `useFilters.ts:21`).
- **SQL.** `t.search_text like $pattern`, where `%needle%` has `\`, `%` and `_` escaped, served by `gin (search_text extensions.gin_trgm_ops)`.
- **Short needles.** 1–2 characters stay allowed. `SEARCH_MIN_CHARS` (default 1) can raise the minimum to 3 if the load test fails short needles (D11).
- **Debounce.** In server mode the text field is debounced by 300 ms (D6).

**Rejected.** Word-start search and the roadmap's French-stemmed tsvector (`docs/map-roadmap-2026-10-25.md:26`) as the default: both change results.

### A10. Drafts are hidden from every new public read

Every public RPC restates the rule:
- an audition counts only when `a.status = 'published'` (`auditions/service.ts:72`);
- a testimony counts only when `(NOT a.audition_en_ligne OR t.verification_status = 'verified')` (`B:654`).

Today `/api/testimonies` has no status filter (`apps/api/src/modules/testimonies/service.ts:52-71`). Drafts' testimonies therefore feed "N résultats", search results and the theme facet, and audition-less testimonies feed the facet (`useTestimonyFiltering.ts:108`). Removing both is D1, a founder question.

The policies at `B:908` and `B:912` stay. The admin RPC (A22) keeps today's admin view: every status.

### A11. RPC execution role and timeouts

**Decision.** Every new read RPC is `plpgsql STABLE SECURITY INVOKER SET search_path = ''`:
- revoked from `public, anon, authenticated`;
- `EXECUTE` granted to `service_role` only;
- called through `adminClient`.

Without `SUPABASE_SERVICE_ROLE_KEY`, the places routes answer 503 (no anon fallback, `apps/api/src/lib/supabase.ts:13-17`).

**Statement bound.**
- M4 sets `alter role service_role set statement_timeout = '5s'`, guarded so that a refusal only raises a notice, then `notify pgrst, 'reload config'`.
- 5 s is below the API's 7 s abort, so the API sees Postgres' 57014 rather than its own abort, and a query never outlives its HTTP call.
- Other `service_role` users:
  - the old app's `handle-registration`, with trivial statements;
  - the new API's writes (`submit_online_testimony` with its housekeeping DELETE, now indexed in B2, and the job's single-row updates).

  Migrations, backups and the seed loader connect as `postgres` and are not affected.
- G records hosted `select rolname, rolconfig from pg_roles` before and after. A pg_sleep probe through local PostgREST proves the bound.

**API side** (D4):
- `abortSignal(AbortSignal.timeout(7000))` as the network backstop.
- 57014 maps to an uncached 503 "Recherche trop large : précisez-la."; the API's abort, and a database out of reach (PostgREST's PGRST000-003, a pooler's prepared-statement errors, a gateway's 5xx, a fetch that threw), to an uncached 503 "Réessayez dans un instant.". In both cases stale data is served if held.
- A gate slot is released when the call settles. If the abort fired first, the slot is held 5 s more, so at most 6 statements run at once.

**Rejected.**
- Anon-callable RPCs, SECURITY DEFINER or invoker.
- A function-level `SET statement_timeout`.
- Keeping 8 s with a 6 s abort: 57014 could never surface, and aborted queries would run on unbounded by the gate.

### A12. Unit metadata comes in the counts response; bboxes come from lieu points

- Each unit row carries `id, parent, level, name, code, country, polygon` from `geo_units`, plus `bbox` = min/max of its matching lieu points.
- The client pads each point by ±0.012°, like `pointBounds`/`unionBounds` (`apps/web/src/features/geo/bounds.ts:13-30`). This reproduces today's bottom-up derivation (`hierarchy.ts:132-154`).
- `applyBoundaries`' re-span still runs on the client (`apps/web/src/features/geo/boundaries.ts:50-57`).
- `FR` keeps `METRO_FRANCE` and `FRANCE_CENTER` (`hierarchy.ts:173-174`).
- French outlines still come from france-geojson, the Géo API and depFine, matched **by code** instead of by name (`useGeoHierarchy.ts:48-62`, `boundaries.ts:43`). They are **gated on country `FR`** (E3).

**Rejected.**
- Client gazetteer chunks for the map.
- Gazetteer polygon bboxes.

### A13. France is resolved at write time from geo.api.gouv.fr; no French gazetteer file in phase 1

One resolver, `frChain(insee)` in `modules/places/fr.ts`, generalised from `fetchCommune` (`townHall.ts:71-99`). It already gets `departement{code,nom}`, `region{code,nom}`, `codeParent` and `type`, and caches them for 30 days. It serves:
- the online form;
- the admin BAN pick;
- the job;
- the backfill generator;
- the seed fixtures.

Département-level and région-level lieux add `/departements/{code}` and `/regions` lookups. FR rows get `geo_release = 'geoapi-<year>'`.

**Drift.** geo.api serves the live COG; the phase-2 tiles are Etalab 2026. Phase 2 falls back to the `fr:dep` on the path, and the yearly remap uses INSEE's table de passage (C7). Every backfilled code is checked against Etalab 2026.

**Rejected.**
- Bundling Etalab or COG in the API: it puts PR #110 on France's critical path.
- A French hierarchical picker in phase 1.

### A14. World gazetteer: content, size and hosting before R2 exists

**Content.** The world except `FR` and the 13 overseas codes, from Overture `2026-10-21.0`:
- every division with an area polygon (country, dependency, region, county, localadmin, locality);
- point-only localities with `class in ('megacity','city','town')` or population ≥ 1,000. Filtering is on `class` and population only, because `local_type` is a localised name map, not an enum.
- **every ancestor of a kept row** (ancestor closure), so no parent dangles.

Each row carries `poly` (a tile polygon exists).

**Measured** (review, read-only DuckDB over `~/.cache/ac-map-data/raw/overture-areas.parquet`, polygon rows only):

| Measure | Value |
|---|---|
| Polygon rows | 583,195 |
| Columnar JSON | 80.8 MB raw, 26.8 MB gzip -9 as one stream |
| Files with the ≤ 8,000-row rule | 631 |
| Largest file | 1.6 MB (a GB region, 10,841 rows) |
| RU | 83 region chunks, 22.1 MB raw |
| US | 51 chunks, 5.1 MB raw |
| CN | 32 chunks, 5.3 MB raw |

The point-only localities are not on disk yet; M's report adds them. Picker search therefore never reads region chunks: it reads one small per-country search index (C3).

**Caps, enforced by the build:**
- ≤ 9,000 files per build;
- chunk ≤ 4 MB raw;
- search index ≤ 4 MB raw per country;
- total ≤ 60 MB gzip.

**Hosting in phase 1.**
- The gazetteer is built on the laptop: DuckDB runs at 12 GB (`WT:build-boundaries.sh:134`) and the 4 GB parquet lives there.
- It is published as a GitHub Release asset with `gh` and pinned in `data/gazetteer.lock.json`.
- The web deploy copies it into Workers static assets under `/geo/<build>/`.
- The API deploy bakes it into the image (`apps/api/Dockerfile:34` copies `data/`).

**Later.** R2 on a custom domain, by switching `VITE_GEO_BASE`.

**Rejected.**
- Committing the files.
- Supabase Storage.
- The API serving chunks or search.
- Building on CI: a private-repo runner has 7 GB of RAM.

### A15. Picker UX

**Online form (testify).** France stays exactly as today: `CommuneCombobox` on data.geopf.fr (`apps/web/src/features/testify/CommuneCombobox.vue:88`), with the arrondissement step (`:34-38`).

When `ONLINE_WORLDWIDE` is on, a "Pays" select (default France) comes first. Other countries get `PlacePicker`:
- "Rechercher" first: folded prefix and substring search over `<CC>.search.json`, ranked by population;
- "Parcourir" second: region → (county) → locality, loading one chunk per region.

The leaf must be a locality or localadmin, or the deepest polygon unit when a country has nothing deeper. A pick sends `{country, unit_id, chunk}`.

**Admin form.**
- France keeps the BAN `LocationCombobox`, which now emits the picked feature (`apps/web/src/features/admin/auditions/LocationCombobox.vue:89-94`): `{label, citycode, lat, lng, type}`. The pick wins over reuse (D12).
- An "À l'étranger" switch shows the country, `PlacePicker` and a free-text lieu name. The point is the locality's label point, with precision `locality`. The lieu key is `normalizeLocation(name)`, with no `LOCATION_RULES`.
- Free text with no pick stays possible; the job places it.

**Where the code lives.** A new leaf feature `features/places` with deps `[]`. In `eslint.config.js:100-116`: `testify: ["places"]` and `admin: ["auth","filters","places"]`.

### A16. Online buckets outside France

- The bucket is (locality unit, Europe/Paris month), as today (`apps/api/src/modules/online-testimonies/service.ts:63-78`).
- For non-French rows `citycode := place_unit`. A 36-character GERS id cannot collide with a 5-character INSEE code. So the unique index (`B:771`), `ON CONFLICT` (`B:439`) and the CHECK (`B:608`) are unchanged.
- A remap repoints `citycode` together with the place columns (C7).
- `place` becomes `{unit, label, country, lat, lng}`, and `OnlinePlace` a union (`packages/shared/src/auditions.ts:26-38`).
- `location` reads "Berlin (Allemagne)". French wording branches on country at `online-testimonies/service.ts:164`, `apps/api/src/lib/email/verification.ts:152,175` and `apps/web/src/features/testify/SubmitTestimonyDialog.vue:121`.
- Shipped behind `ONLINE_WORLDWIDE` until the founder approves.

**Rejected.** A second bucket column.

### A17. Lazy unit tree with an adaptive complete subtree, served in batches

- `GET /api/places?units=U1,U2,…&depth=2` (≤ 50 units; `unit=U` is the single form) returns, for each unit:
  - its units two levels down;
  - every lieu hanging under the unit or its depth-1 children.
- When a whole subtree holds ≤ `budget` (600) units plus lieux, it returns all of it with `complete: true`, plus:
  - analyses facts for every unit;
  - each lieu's audition list (`{id,title,date,n}`) and `city`.
- `?budget=` is honoured only with `TEST_TOOLS`; `budget=0` forces the lazy path.
- The API caches **per unit**. Misses of one request are fetched in RPC calls of ≤ 20 units (`place_counts_many`).

**Rejected.**
- Always lazy.
- Always whole.
- One request per unit: one drill step can ensure dozens of communes (`useMapFeed.ts:259-273`).

### A18. Orders and tie-breaks reproduce today

**How today's orders arise.**
- `/api/map` groups are inserted in order of their newest audition: auditions come `date desc` (`auditions/service.ts:69-73`) into a Map keyed by `placeKeyOf` (`locationGroups.ts:22-31`).
- An online group's point is its newest audition's (`locationGroups.ts:63-66`).
- That insertion order sits behind three stable sorts: children by count (`hierarchy.ts:153`), results by date (`apps/web/src/features/geo-nav/model/usePanelAuditions.ts:77-82`, `bySort` at `apps/web/src/features/geo-nav/model/auditions.ts:19-28`), and the strict `>` arg-max (`scopeStats.ts:159`).

**Decision.** Every RPC computes, per lieu, over the unfiltered visible set:
- `rank(lieu) = max(date)`;
- `tie(lieu)`, the id of that newest audition (`order by date desc, id`);
- the lieu's point and `city`, from that audition.

A unit's rank and tie are those of its first matching lieu in (rank desc, tie) order.

| What | Order |
|---|---|
| Children | testimonies desc, rank desc, tie, id |
| Results | date (asc or desc), rank desc, tie, id |
| Largest audition | n desc, rank desc, tie, date desc, id |
| Lieu auditions | date (asc or desc), id |
| Panel testimonies | `coalesce(created_at, '-infinity') asc, id desc` (`auditions.ts:46-48` over `testimonies/service.ts:62-63`) |

Since PR A, `/api/map`'s rows come `date desc, id`, so today's ties are deterministic: groups follow their newest audition's (date, id). The RPCs reproduce that order exactly (no D3 left; changed in PR G's review). Every unit and lieu of `place_counts` carries its `tie`, so the web merges siblings from different answers in the same order. `date` is NOT NULL (`B:598`).

### A19. Caches and memory: byte-bounded families, a generation counter, one memory budget

- **`CacheFamily`** in `apps/api/src/lib/cache.ts` keeps its own `Map`:
  - LRU, refreshed on hit;
  - budgeted in bytes as `json.length + gz.length`. These are Buffers held outside the V8 heap (`lib/cache.ts:46-56`).
- **One `generation` per family.** A fill keeps its value only if the generation is unchanged. `invalidatePublicCaches()` (`apps/api/src/lib/publicCache.ts:49-53`) bumps every family.
- **One process memory budget** on the 512 MB container (`deploy-staging.yml:94-96`):

  | Part | Budget |
  |---|---|
  | V8 heap | `--max-old-space-size=256` |
  | Boundaries LRU (`boundaries/service.ts:41`), parsed values within the heap (PR H) | ≤ 32 MB |
  | Cache families | ≤ 74 MB of Buffers: 64 MB of answers, 10 MB of responses assembled from them (D1, D3) |
  | Gazetteer chunk LRU | ≤ 16 MB |
  | **External total** (families and gazetteer) | **≤ 90 MB** |

- `/api/health?details=1` (staging) reports RSS, heap, external, and bytes per family and per LRU.

**Rejected.**
- `invalidate(oldestKey)` eviction.
- Key-count bounds.
- A heap cap alone, which does not bound Buffers.

### A20. Toggles and diffs

| Toggle | Where | Values (default first) |
|---|---|---|
| `MAP_SOURCE` | API env (D) | `db` (staging) \| `geocoder`. On staging with `TEST_TOOLS`, `?source=geocoder` serves the other build. |
| "Données" | Web dev switch (`features/temoignages/dataSource.ts`, `__TEST_TOOLS__`, `localStorage['ac:data-source']`, modelled on `features/analyses/devSwitch.ts`) | `corpus` \| `serveur` \| `comparer` (`window.__acCompare` holds the diffs; a dev badge shows the count). Prod keeps the constant `DEFAULT_SOURCE`, which L flips. |
| "Analyses en attente" | Web dev switch (J) | `garder` \| `masquer`. It matters only on the lazy path. |
| "Arbre des lieux" | Web dev switch (J) | `sans arrondissements` (today) \| `avec arrondissements` |
| Picker first mode | Web dev switch (N) | `Rechercher` \| `Parcourir` |
| `SEARCH_MIN_CHARS` | API env | `1` (today) \| `3` |
| `ONLINE_WORLDWIDE` | API env + web build flag | off on prod, on on staging |
| `RATE_LIMITS=relaxed` | API env, refused unless `APP_ENV=staging` | off \| relaxed (load campaign only, F3) |

### A21. Deliberate visible changes

Everything not listed here must come out of the harnesses identical.

| # | Change |
|---|---|
| D1 | Testimonies of draft (or NULL-status) auditions leave "N résultats", search results and the theme facet. Audition-less testimonies leave the theme facet. |
| D2 | Place-filter tokens become unit and lieu ids. A ville pick no longer matches a same-named ville in another département (`filters.ts:30`). |
| D3 | Retired in PR G's review: today's tie order is deterministic since PR A, and the RPCs reproduce it (A18). |
| D4 | A homonym is settled once and never moves; an unsettled one is retried as support grows. |
| D5 | Staging only, until L: the first visitor after a deploy waits for the corpus. |
| D6 | In server mode, **every filter change** answers asynchronously (one round trip; text debounced 300 ms). The previous tree, lists and figures stay on screen until the answer arrives. List mode turns on with the debounced text, not the first keystroke. |
| D7 | A unit without a polygon gets a box fit, pins and no plateau, instead of holding the previous plateau forever (`apps/web/src/features/geo-nav/model/useMapFeed.ts:104-106`). |
| D8 | Staging only: world-seed lieux appear once N lands. |
| D9 | More than 1,000 published auditions all reach the map (`auditions/service.ts:69-73`; `supabase/config.toml:23`). |
| D10 | An opened audition loads its testimonies, 50 at a time (the first page is prefetched for the open lieu's auditions). Result pages load from the server. Both reuse the existing loading states (`apps/web/src/features/geo-nav/panel/AuditionList.vue:94-100`). |
| D11 | Conditional: a 3-character search minimum, only if the load test forces it. |
| D12 | An admin's explicit BAN pick places that audition at the pick, even when another audition with the same lieu name is placed elsewhere. Today the text is re-geocoded and same-named lieux always merge. |
| D13 | Lazy path only (above 600 units plus lieux, i.e. staging at scale): opening a lieu waits for its audition list, with LoadingDots in the list. |
| D14 | A change to `LOCATION_RULES` regroups stored lieux on the job's first pass after the deploy, not at the next read. Likewise, the read RPCs read an audition the old app inserted or moved (`place_stale`) at its stored place until the job's next pass: an insert stays unplaced, a moved one at its previous lieu. The place reads nudge the job (at most once a minute), so while the site is read that is about a minute; otherwise at most 10 minutes. `/api/map` (D6) files such a row by its name at once. |

### A22. Admin list filters on the server (contract)

Today `useAuditionFilters` (`apps/web/src/features/admin/auditions/useAuditionFilters.ts:128-141`) passes an audition when:
- with only text: `textInAudition || some testimony's hay contains the needle`;
- with verified or themes on: `some testimony passes verified/themes && (textInAudition || its hay contains the needle)`.

Here `textInAudition = fold(title location content).includes(needle)`. The theme options are `buildTopicOptions` over the testimonies of *reachable* auditions (`:113-121`). Reachable means all auditions for a super admin, otherwise the admin's own (`useAdminAuditions.ts:33-36`).

**Decision.**
- `admin_audition_filter(p_filters, p_reachable_by)` returns, per audition with testimonies (any status):
  - `n_all`: testimonies passing verified, themes and text;
  - `n_no_text`: testimonies passing verified and themes.

  It also returns the 16 theme counts over the reachable auditions' testimonies.
- The client keeps `textInAudition` and combines:
  - text only → `textInAudition || n_all > 0`;
  - verified or themes on → `textInAudition ? n_no_text > 0 : n_all > 0`.
- Theme options are rebuilt from the counts with `buildTopicOptions`' sort (`filters.ts:155-165`). The place and date filters stay client-side.
- A text the place reads refuse (over 200 characters once folded, or a NUL) is asked without `q`, and `n_all` is counted in the page over `/api/testimonies/admin/filterable`, as today (L's review). Q must keep it found when it removes that route.
- The API passes `p_reachable_by = null` for a super admin, else the caller's id.
- `/api/testimonies/admin/filterable` (`testimonies/service.ts:78-95`) stays until Q, and is removed only after the admin parity check passes.

**Rejected.** A single filtered count: it cannot express `textInAudition`.

---

## B. Database

### B1. Migrations, rules and order

| # | File (PR) | Content | Prod effect |
|---|---|---|---|
| M1 | `<ts>_testimony_derived.sql` (B) | pg_trgm; schema `ac` with default privileges; helpers; 5 columns; trigger; backfill touch; 4 indexes | Trigger rewrites ~252 rows; indexes build in ms |
| M2 | `<ts>_audition_places.sql` (C) | `geo_units`; 12 columns + 2 generated; CHECKs; indexes; `placement_support`; `submit_online_testimony` with defaulted place args | Rewrite of ~64 rows |
| M3 | `<ts>_backfill_places_fr.sql` (E) | ~15 `geo_units` + a keyed UPDATE | ~64 rows |
| M4 | `<ts>_read_rpcs.sql` (G) | Filter helpers; 7 read RPCs + the admin RPC; `service_role` 5 s | No data change |

**Rules.**
1. Every file starts with `set lock_timeout = '200ms'` (`M7:29`).
2. Timestamps are assigned when the PR merges (rename in the final rebase).
3. After merge: dry run, then push to staging, then prod. A migration is on staging before any PR whose code calls its objects merges (`.github/workflows/deploy-staging.yml` deploys on every push to dev).
4. Each DB PR regenerates `packages/shared/src/database.types.ts`.
5. Additive only. `testimonies_audition_id_idx` (`B:791`) is dropped only in Q.
6. **Every migration that creates functions in `ac` ends with:**
   ```sql
   revoke all on all functions in schema ac from public, anon, authenticated;
   grant execute on all functions in schema ac to service_role;
   ```
   This is in addition to M1's default privileges, and the grant guard checks it.

### B2. M1: derived testimony columns (PR B)

```sql
set lock_timeout = '200ms';
create extension if not exists pg_trgm with schema extensions;
do $$ begin
  if not exists (select 1 from pg_catalog.pg_collation where collname = 'und-x-icu') then
    raise exception 'ICU collation und-x-icu missing: the search fold would not match the browser';
  end if;
end $$;

-- Helpers live in a schema PostgREST does not expose (supabase/config.toml:18 exposes public, graphql_public).
create schema if not exists ac;
revoke all on schema ac from public;
grant usage on schema ac to service_role;
-- New functions in ac must not get Postgres' default EXECUTE-to-PUBLIC (B:1329-1352 covers public only).
alter default privileges for role postgres in schema ac revoke execute on functions from public;
alter default privileges for role postgres in schema ac grant execute on functions to service_role;

alter table public.testimonies
  add column search_text text,
  add column theme_mask integer,
  add column themes_approx boolean,
  add column untagged boolean,
  add column derive_version smallint;

-- Generated by scripts/sql-gen/derived.ts from @ac/shared (do not hand-edit).
-- WS = the JS \s / String.prototype.trim class, spelled with ARE escapes (never PG's locale-dependent \s):
--   [\t\n\v\f\r    -     　﻿]
create function ac.js_trim(p text) returns text language sql immutable strict parallel safe
  set search_path = '' return pg_catalog.regexp_replace(p, '^[<WS>]+|[<WS>]+$', '', 'g');
create function ac.js_collapse(p text) returns text language sql immutable strict parallel safe
  set search_path = '' return pg_catalog.regexp_replace(p, '[<WS>]+', ' ', 'g');
-- fold() of filters.ts:9-14: NFD, strip U+0300–U+036F, lower case (ICU root = V8). normalize unqualified (verified).
create function ac.fold(p text) returns text language sql immutable strict parallel safe
  set search_path = '' return pg_catalog.lower(
    pg_catalog.regexp_replace(normalize(p, NFD), '[̀-ͯ]', '', 'g') collate "und-x-icu");
-- themeKey of themes.ts:40-48
create function ac.theme_key(p text) returns text language sql immutable strict parallel safe
  set search_path = '' return pg_catalog.btrim(ac.js_collapse(pg_catalog.translate(ac.fold(p), '‘’', '''''')), ' ');

-- read() of themes.ts:128-144: an exact grid name is "canonical" (themes.ts:105-108); else BY_KEY (38 keys).
create function ac.theme_bits(p_topics text[], out mask int, out approx boolean)
language plpgsql immutable parallel safe set search_path = '' as $$
declare tag text; idx int; is_approx boolean; firm boolean := false;
begin
  mask := 0;
  foreach tag in array coalesce(p_topics, '{}') loop
    continue when tag is null;
    idx := case tag when 'Santé et accès aux soins' then 0 /* …16 grid names, AUDITION_THEMES order… */ end;
    if idx is not null then mask := mask | (1 << idx); firm := true; continue; end if;
    idx := null;
    select k.i, k.a into idx, is_approx
      from (values ('sante et acces aux soins', 0, false) /* …38 BY_KEY rows… */) as k(key, i, a)
     where k.key = ac.theme_key(tag);
    continue when idx is null;
    mask := mask | (1 << idx);
    if not is_approx then firm := true; end if;
  end loop;
  approx := mask <> 0 and not firm;              -- themes.length > 0 && !firm
end $$;

-- parseAnswers/answersText of answers.ts:64-100, line for line:
--   split on \r?\n; normalize(line) = btrim(js_collapse(line), ' ') then ' ?\?$' -> ' ?';
--   a question opens only after the previous one; non-blank text before the first question -> content;
--   each answer = js_trim(lines joined by \n), empty ones dropped; none left -> content; join by \n\n.
create function ac.answers_text(p_content text) returns text
language plpgsql immutable strict parallel safe set search_path = '' as $$ … $$;

create function ac.testimonies_derive() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    new.search_text := ac.fold(new.person_name || ' ' || coalesce(new.person_info, '') || ' '
                               || ac.answers_text(new.content));
    select b.mask, b.approx into new.theme_mask, new.themes_approx from ac.theme_bits(new.topics) b;
    new.untagged := coalesce(pg_catalog.cardinality(new.topics), 0) = 0;   -- !topics?.length (scopeStats.ts:126)
    new.derive_version := 1;
  exception when others then        -- never block a write (old app, verify-by-token, RPCs, seed)
    new.search_text := null; new.theme_mask := null; new.themes_approx := null;
    new.untagged := null; new.derive_version := -1;
  end;
  return new;
end $$;
create trigger testimonies_derive before insert or update on public.testimonies
  for each row execute function ac.testimonies_derive();

update public.testimonies set topics = topics;   -- fires the trigger: ~252 rows on prod

create index testimonies_search_trgm_idx on public.testimonies
  using gin (search_text extensions.gin_trgm_ops);
-- Index-only counts and per-audition keyset paging in one index
create index testimonies_audition_facts_idx on public.testimonies
  (audition_id, (coalesce(created_at, '-infinity'::timestamptz)), id desc)
  include (verification_status, theme_mask, themes_approx, untagged);
-- verify_testimony_by_token compares verification_token (B:539-575): a seq scan at 300k
create index testimonies_verification_token_idx on public.testimonies (verification_token)
  where verification_token is not null;
-- submit_online_testimony's housekeeping DELETE of pending rows older than 15 days (B:413-427), on every call
create index testimonies_pending_created_idx on public.testimonies (created_at)
  where verification_status = 'pending';

revoke all on all functions in schema ac from public, anon, authenticated;
grant execute on all functions in schema ac to service_role;
```

Notes:
- **No column grant** to anon or authenticated. `testimonies` already has column-level SELECT on 9 columns only (`B:1392-1405`).
- **Firing as `authenticated`.** The trigger is SECURITY DEFINER (owner postgres), so the revoked helpers run under old-app writes. CI proves it (B7). Fallback if schema USAGE ever bites: move the trigger function to `public`, still revoked.
- **Shared code.** `fold`, `passesContent` and `passesDate` move to `packages/shared/src/filters.ts`; the web re-exports them. `themes.ts` exports `THEME_KEY_TABLE`; `answers.ts` exports its normalised questions.

### B3. M2: places (PR C)

```sql
set lock_timeout = '200ms';
create table public.geo_units (
  id          text primary key,                  -- never updated: a remap inserts + repoints + deletes (C7)
  parent_id   text references public.geo_units (id),
  level       text not null check (level in ('country','dependency','region','county','localadmin','locality')),
  country     text not null check (country ~ '^[A-Z]{2}$'),
  name        text not null,                     -- French label where the source has one ("Lyon 7e")
  code        text,                              -- INSEE for France; ISO 3166-2 for an Overture region when known
  lat double precision, lng double precision,    -- label point, optional
  polygon     boolean not null default true,     -- has a tile polygon; phase 2 lights the nearest polygon ancestor otherwise
  wikidata    text,
  source      text not null check (source in ('insee','overture')),
  geo_release text not null,                     -- 'geoapi-2026' | '2026-10-21.0'
  updated_at  timestamptz not null default now(),
  constraint geo_units_root check ((parent_id is null) = (level in ('country','dependency')))
);
alter table public.geo_units enable row level security;           -- no policy: server only
revoke all on public.geo_units from anon, authenticated;
grant select, insert, update, delete on public.geo_units to service_role;
create index geo_units_parent_idx on public.geo_units (parent_id);

alter table public.auditions
  add column place_unit text references public.geo_units (id) on delete restrict,
  add column place_path text[],
  add column locality_id text,
  add column lieu_key text,
  add column lat double precision,
  add column lng double precision,
  add column place_precision text,
  add column place_candidates jsonb,
  add column placed_location text,
  add column placed_rules text,                  -- hash of LOCATION_RULES at placement (A7)
  add column geo_release text,
  add column place_stale boolean generated always as (placed_location is distinct from location) stored,
  add column lieu_id text generated always as (
    case when place_unit is not null and lieu_key is not null
         then 'l:' || left(md5(place_unit || chr(31) || lieu_key), 16) end) stored,
  add constraint auditions_place_precision check (place_precision in
    ('address','commune','locality','departement','region','country','unplaced')),
  add constraint auditions_place_point check ((lat is null) = (lng is null)
    and (lat is null or (lat between -90 and 90 and lng between -180 and 180))),
  add constraint auditions_place_path check (place_path is null or (
    pg_catalog.cardinality(place_path) between 1 and 8
    and place_path[pg_catalog.cardinality(place_path)] = place_unit
    and place_path[1] ~ '^[A-Z]{2}$' and pg_catalog.array_position(place_path, null) is null)),
  add constraint auditions_place_placed check
    ((place_precision is null or place_precision = 'unplaced') = (place_path is null)),
  add constraint auditions_place_lieu check (place_path is null or (lieu_key is not null and lat is not null));

create index auditions_place_path_idx on public.auditions using gin (place_path) where status = 'published';
create index auditions_lieu_id_idx    on public.auditions (lieu_id) where status = 'published';
create index auditions_lieu_key_idx   on public.auditions (lieu_key) where place_path is not null and not audition_en_ligne;
create index auditions_stale_idx      on public.auditions (created_at) where place_stale;

-- Homonym support from stored rows: distinct lieux per département among published offline rows
-- placed without homonym involvement (settleHomonyms semantics, match.ts:447-456). Reuse copies
-- place_candidates (A6), so a reused homonym never counts.
create function public.placement_support() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_object_agg(dep, n), '{}') from (
    select pg_catalog.split_part(p, ':', 3) as dep, count(distinct a.lieu_key) as n
    from public.auditions a cross join lateral pg_catalog.unnest(a.place_path) as p
    where a.status = 'published' and not a.audition_en_ligne and a.place_candidates is null
      and a.place_path is not null and not a.place_stale and p like 'fr:dep:%'
    group by 1) s $$;
revoke all on function public.placement_support() from public, anon, authenticated;
grant execute on function public.placement_support() to service_role;

-- submit_online_testimony (B:387-479), same body, with defaulted place arguments.
drop function public.submit_online_testimony(text,text,text,text,text,text,jsonb,date,text,text,uuid);
create function public.submit_online_testimony(
  p_email_hash text, p_person_name text, p_person_info text, p_content text, p_citycode text,
  p_location text, p_place jsonb, p_month date, p_title text, p_audition_content text, p_token uuid,
  p_place_unit text default null, p_place_path text[] default null, p_locality_id text default null,
  p_lat double precision default null, p_lng double precision default null,
  p_place_precision text default null, p_geo_release text default null) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$ … $$;   -- B:389 clause
--  the insert loop (B:435-450) is unchanged; after it, one guarded UPDATE places the bucket
--  when unit, path, precision, lat and lng are all given (v_place), under its own label:
--    update public.auditions set place_unit = p_place_unit, …, lieu_key = location, placed_location = location
--     where id = v_audition and place_path is null;
--  wrapped in `exception when check_violation or foreign_key_violation then null`: a partial or
--  refused place leaves the bucket stale for the job, and the testimony is filed all the same.
revoke all on function public.submit_online_testimony(text,text,text,text,text,text,jsonb,date,text,text,uuid,
  text,text[],text,double precision,double precision,text,text) from public, anon, authenticated;
grant execute on function public.submit_online_testimony(…same…) to service_role;
```

**Prod safety.**
- **New columns.** All nullable, with no default. The two stored generated columns rewrite about 64 rows.
- **No grant needed for FK checks.** They run as the table owner, so `authenticated` needs nothing on `geo_units`.
- **`select('*')`.** The old app's `select('*')` (`OLD: pages/AuditionDetail.tsx:40-42`) receives the new scalar columns. None is personal.
- **Older API builds.** The staging API before D calls the 11-argument form; PostgREST resolves it through the defaults. The row is born stale.
- **Why drop and re-create:** two overloads with defaults would make the 11-argument call ambiguous.
- **Row states.**

  | State | Columns |
  |---|---|
  | Never placed | `placed_location` NULL, so stale |
  | Placed | path and point set, `placed_location = location`, `placed_rules` set |
  | Unplaced after an attempt | path NULL, `place_precision = 'unplaced'`, `placed_location = location` |

### B4. M3: the reviewed France backfill (PR E)

**Generator: `scripts/place-backfill/generate.ts`.** It reads the target's auditions with the publishable (anon) key: `id, title, date, location, status, audition_en_ligne, citycode, place, created_at`.
- **Coverage.** Auditions are public (`B:908`), drafts included. Unverified-only online auditions are hidden from anon (`B:888`); they stay stale until the cutover sweep.
- **No prod geocode cache exists:** the API is not deployed to prod, and containers are disposable (`apps/api/Dockerfile:40-41`).
- **Online rows:** `frChain(citycode)`, point from `place.lat/lng`, precision `address`.
- **Offline rows:** D's `placeLieu`, text-only (no pick). Homonyms settle over the plan's own published offline lieux (`locationGroups.ts:53-63`).
- **Cross-check, warning only:** point-in-polygon against the Etalab 2026 communes in `~/.cache/ac-map-data/raw`.

**Outputs.**
1. The migration.
2. `supabase/tests/backfill_places_fr.sql` plus `supabase/tests/backfill_places_fr.expected.json` (expected location → unit list, also used by B7 step 5).
3. `docs/backfill-places-<date>.md`, the review table. Per row: raw location, canonical, class, INSEE, unit chain, point and precision. It flags rule collapses, near-duplicates within 50 m, homonyms and unplaced rows. It counts NULL `created_at`, NULL status, NULL `audition_id` testimonies and online rows.

```sql
set lock_timeout = '200ms';
insert into public.geo_units (id, parent_id, level, country, name, code, source, geo_release) values
  ('FR', null, 'country', 'FR', 'France', null, 'insee', 'geoapi-2026'),
  ('fr:reg:84', 'FR', 'region', 'FR', 'Auvergne-Rhône-Alpes', '84', 'insee', 'geoapi-2026'),
  ('fr:dep:69', 'fr:reg:84', 'county', 'FR', 'Rhône', '69', 'insee', 'geoapi-2026'),
  ('fr:com:69123', 'fr:dep:69', 'locality', 'FR', 'Lyon', '69123', 'insee', 'geoapi-2026'),
  ('fr:com:69382', 'fr:com:69123', 'locality', 'FR', 'Lyon 2e', '69382', 'insee', 'geoapi-2026') /* … ≈15 */
on conflict (id) do nothing;

with v(online, location, citycode, unit, path, locality, key, lat, lng, prec, cand) as (values
  (false, 'Place Bellecour, Lyon', null, 'fr:com:69382',
   '{FR,fr:reg:84,fr:dep:69,fr:com:69123,fr:com:69382}'::text[], 'fr:com:69123',
   'Place Bellecour, Lyon', 45.7578, 4.8320, 'address', null::jsonb) /* … one row per reviewed lieu … */)
update public.auditions a
   set place_unit = v.unit, place_path = v.path, locality_id = v.locality,
       lieu_key = case when v.online then a.location else v.key end,     -- online: the row's own label (A6)
       lat = v.lat, lng = v.lng, place_precision = v.prec, place_candidates = v.cand,
       placed_location = a.location, placed_rules = '<rules hash at generation>', geo_release = 'geoapi-2026'
  from v
 where a.placed_location is null
   and a.audition_en_ligne = v.online
   and ((not v.online and a.location = v.location) or (v.online and a.citycode = v.citycode));
-- then a DO block raises NOTICEs: rows placed, rows still stale (changed since the review)
```

**Behaviour.**
- Offline rows match by raw `location`; online rows match by `citycode` and keep their own label as key.
- Idempotent and non-destructive: it touches only never-placed rows.
- Rows changed since the review are skipped and stay stale.
- On staging it places seed rows with identical strings, since the seed mirrors prod's lieux (`scripts/seed/places.ts:22-23,45,50,57`).
- On CI (fresh DB, no seed yet) it is a no-op. Step 5 and the fixture cover it.

### B5. M4: read RPCs (PR G)

**Conventions.**
- `plpgsql STABLE SECURITY INVOKER SET search_path = ''`.
- Revoked from `public, anon, authenticated`; `EXECUTE` to `service_role`.
- One jsonb result, which escapes `max_rows = 1000` (`supabase/config.toml:23`).
- SQL is built from fixed fragments and run with `EXECUTE … USING`, so no user text is interpolated and the trigram and GIN indexes are usable.

**Filters.** The API sends one jsonb: `{"verified":true,"mask":1234,"like":"%clim%","from":"2025-01-01","to":"2025-12-31","units":["fr:dep:69"],"lieux":["l:3fa…"]}`.

```sql
create type ac.filters as (mask int, "like" text, from_date date, to_date date, units text[], lieux text[], verified boolean);
-- Validates and types. Raises 22023 on unknown keys, mask outside 0..65535, "like" > 404 chars,
-- more than 50 units or lieux, malformed ids.
create function ac.read_filters(p jsonb) returns ac.filters language plpgsql immutable set search_path = '' as $$ … $$;
-- Only the active predicates, binding filter values at $1..$6.
create function ac.filter_sql(p jsonb) returns text language plpgsql immutable set search_path = '' as $$
declare s text := '';
begin
  if coalesce((p->>'verified')::boolean, false) then s := s || ' and t.verification_status = ''verified'''; end if;
  if coalesce((p->>'mask')::int, 0) <> 0 then s := s || ' and (t.theme_mask & $1) <> 0'; end if;
  if p ? 'like'  then s := s || ' and t.search_text like $2'; end if;
  if p ? 'from'  then s := s || ' and a."date" >= $3'; end if;
  if p ? 'to'    then s := s || ' and a."date" <= $4'; end if;
  if p ? 'units' or p ? 'lieux' then
    s := s || ' and (a.place_path && coalesce($5, ''{}'') or a.lieu_id = any(coalesce($6, ''{}'')))';
  end if;
  return s;
end $$;
-- auditionCohort (packages/shared/src/auditions.ts:92-99) + GENERIC_LOCATION (locations.ts:114-120), ctype-proof
create function ac.cohort(p_title text, p_location text) returns text
language sql immutable parallel safe set search_path = '' return case
  when pg_catalog.lower(ac.js_trim(p_location) collate "und-x-icu")
       in ('france','métropole','metropole','en ligne','internet','divers','inconnu') then 'archive'
  when pg_catalog.lower(ac.js_trim(p_title) collate "und-x-icu") ~ '^cahiers? de doléances' then 'cahier2019'
  else 'terrain' end;
```

**The facts fragment `%2$s`.** This is each unit's analyses figures, mirroring `readAudition`/`addAudition` (`scopeStats.ts:120-165`) and the fields `analyseScope` reads (`scopeStats.ts:247-323`):

```sql
jsonb_build_object(
  'testimonies', coalesce(sum(n), 0),
  'auditions',   count(*) filter (where n > 0),
  'lieux',       count(distinct lieu_id) filter (where n > 0),
  'communes',    count(distinct locality_id) filter (where n > 0),      -- arrondissements roll up (communeOf)
  'cohorts',     jsonb_build_array(coalesce(sum(n) filter (where cohort = 'terrain'), 0),
                                   coalesce(sum(n) filter (where cohort = 'cahier2019'), 0),
                                   coalesce(sum(n) filter (where cohort = 'archive'), 0)),
  'themes',         jsonb_build_array(coalesce(sum(th[1]), 0), /* … */ coalesce(sum(th[16]), 0)),
  'themeAuditions', jsonb_build_array(count(*) filter (where th[1] > 0), /* … */ count(*) filter (where th[16] > 0)),
  'themeBase', coalesce(sum(base), 0), 'untagged', coalesce(sum(untagged), 0), 'approx', coalesce(sum(approx), 0),
  'first', min("date") filter (where cohort = 'terrain' and n > 0),
  'last',  max("date") filter (where cohort = 'terrain' and n > 0),
  'largest', (array_agg(jsonb_build_array(id, lieu_id, lieu_key, n, pcity)
               order by n desc, rank desc, tie, "date" desc, id) filter (where n > 0))[1])
```

#### 1. `place_counts` and `place_counts_many`

`place_counts(p_unit text default 'world', p_filters jsonb default '{}', p_depth int default 2, p_facts boolean default false, p_budget int default 600, p_empty boolean default false) returns jsonb`

- **Validation.** It raises 22023 when `p_depth` is not in 1..3, when `p_budget` is not in 0..2000, or when `p_empty` comes with filters.
- **Call shape.** `execute format(<below>, ac.filter_sql(p_filters), <facts>) into v_out using f.mask, f."like", f.from_date, f.to_date, f.units, f.lieux, p_unit, p_depth, p_budget, p_facts, p_empty;`

```sql
with
vis as (      -- what /api/map lists today, unfiltered: published and placed; online once it has a verified testimony
  select a.id, a.title, a."date", a.lieu_id, a.place_unit, a.place_path, a.locality_id, a.lieu_key,
         a.lat, a.lng, a.place_precision, ac.cohort(a.title, a.location) as cohort,
         case when a.audition_en_ligne then a.place->>'commune' else lc.name end as city,   -- today's g.city
         coalesce(pg_catalog.array_position(a.place_path, $7), 0) as k
  from public.auditions a
  left join public.geo_units lc on lc.id = a.locality_id
  where a.status = 'published' and a.place_path is not null
    and ($7 = 'world' or a.place_path @> array[$7])
    and (not a.audition_en_ligne or exists (select 1 from public.testimonies v       -- M7:97-99 index
           where v.audition_id = a.id and v.verification_status = 'verified'))),
lmd as (      -- per lieu, its newest visible audition: today's group order (rank, tie), pin and city (A18)
  select distinct on (lieu_id) lieu_id, "date" as rank, id as tie, lat as plat, lng as plng, city as pcity
  from vis order by lieu_id, "date" desc, id),
m as (        -- matching visible testimonies per audition; index-only on the facts index
  select t.audition_id, count(*)::int as n,
         count(*) filter (where t.theme_mask <> 0)::int as base,
         count(*) filter (where t.untagged)::int as untagged,
         count(*) filter (where t.themes_approx)::int as approx,
         array[count(*) filter (where t.theme_mask & 1 <> 0), /* … */
               count(*) filter (where t.theme_mask & 32768 <> 0)]::int[] as th
  from public.testimonies t join public.auditions a on a.id = t.audition_id
  where a.status = 'published'
    and (not a.audition_en_ligne or t.verification_status = 'verified')          -- B:654
    and ($7 = 'world' or a.place_path @> array[$7])
    %1$s
  group by t.audition_id),
s as (select vis.*, lmd.rank, lmd.plat, lmd.plng, lmd.pcity, coalesce(m.n, 0) as n,
             m.base, m.untagged, m.approx, m.th
      from vis join lmd using (lieu_id) left join m on m.audition_id = vis.id
      where m.n > 0 or $11),                 -- empty=1 keeps zero-testimony auditions (card, filter tree)
u as (select x.unit, x.d::int as d, s.*
      from s cross join lateral pg_catalog.unnest(s.place_path[s.k + 1 :]) with ordinality as x(unit, d)),
lim as (select case when (select count(distinct unit) from u) + (select count(distinct lieu_id) from s) <= $9
                    then 99 else $8 end as depth)
select jsonb_build_object(
  'unit', $7, 'complete', (select depth from lim) = 99,
  'self', (select jsonb_build_object('n', coalesce(sum(n), 0), 'auditions', count(*) filter (where n > 0))
                  || case when $10 and $7 <> 'world' then jsonb_build_object('facts', %2$s) else '{}'::jsonb end
           from s),                                                     -- placed rows only: never double-counts
  'unplaced', case when $7 = 'world' then (
           select jsonb_build_object('n', coalesce(sum(m.n), 0), 'auditions', count(*))
           from m join public.auditions a on a.id = m.audition_id where a.place_path is null) end,
  'units', coalesce((select jsonb_agg(jsonb_build_object(
             'id', r.id, 'parent', g.parent_id, 'level', g.level, 'name', g.name, 'code', g.code,
             'country', g.country, 'polygon', g.polygon, 'd', r.d, 'n', r.n, 'auditions', r.auditions,
             'rank', r.rank, 'bbox', jsonb_build_array(r.min_lat, r.min_lng, r.max_lat, r.max_lng),
             'wrap', (r.max_lng - r.min_lng) > 180, 'facts', r.facts) order by r.n desc, r.rank desc, r.tie, r.id)
           from (select u.unit as id, min(u.d) as d, sum(u.n)::int as n,
                        count(*) filter (where u.n > 0)::int as auditions, max(u.rank) as rank,
                        min(u.plat) as min_lat, min(u.plng) as min_lng, max(u.plat) as max_lat, max(u.plng) as max_lng,
                        case when $10 and ((select depth from lim) = 99 or min(u.d) = 1)   -- complete: every unit
                             then %2$s end as facts
                 from u where u.d <= (select depth from lim) group by u.unit) r
           join public.geo_units g on g.id = r.id), '[]'),
  'lieux', coalesce((select jsonb_agg(jsonb_build_object(
             'id', l.lieu_id, 'unit', l.place_unit, 'key', l.lieu_key, 'city', l.pcity,
             'lat', l.plat, 'lng', l.plng, 'precision', l.prec, 'n', l.n, 'auditions', l.auditions,
             'rank', l.rank,
             'list', case when (select depth from lim) = 99 then l.list end)      -- complete: the open lieu's list
             order by l.n desc, l.rank desc, l.tie)
           from (select lieu_id, place_unit, lieu_key, pcity, plat, plng, min(place_precision) as prec,
                        sum(n)::int as n, count(*) filter (where n > 0)::int as auditions, max(rank) as rank,
                        jsonb_agg(jsonb_build_array(id, title, "date", n) order by "date" desc, id) as list
                 from s where pg_catalog.cardinality(place_path) - k between 0 and (select depth from lim) - 1
                 group by lieu_id, place_unit, lieu_key, pcity, plat, plng) l), '[]'));
```

What it reproduces:
- unit counts are sums of descendants (`hierarchy.ts:125,172`);
- members are auditions with at least one matching testimony (`scopeStats.ts:199-213`, `useTestimonyFiltering.ts:85-86`);
- bboxes come from the lieu points (A12);
- lieu points and cities are those of the newest visible audition (`locationGroups.ts:63-66,92-97`);
- the facts above;
- each lieu's audition list as `placeAuditions` builds it (`usePanelAuditions.ts:64-75`). The client re-sorts it with `bySort`.

**Batched form.** `place_counts_many(p_units text[], <same args>) returns jsonb`:
- loops `place_counts` over 1..20 units and returns a jsonb array in order;
- raises 22023 outside that range;
- the API splits larger requests (D4).

#### 2. `lieu_auditions`

`lieu_auditions(p_lieu text, p_filters jsonb default '{}', p_sort text default 'recent') returns jsonb`

- Returns `{lieu:{id, unit, key, path, lat, lng, city}, auditions:[{id, title, date, n}]}`, with `n > 0` and date in `p_sort`'s direction, then id.
- It serves the lazy path's open lieu (D13) and `openResultAt`.

#### 3. `audition_results`

`audition_results(p_filters jsonb default '{}', p_sort text default 'recent', p_after jsonb default null, p_limit int default 50, p_through uuid default null) returns jsonb`

- **Rows.** Matching **placed** auditions (`usePanelAuditions.ts:77-82`), each `{id, title, date, n, lieu:{id, key, unit, path, lat, lng, city}}`. The lieu point and city come from `lmd`, so a result can be opened, flown to and labelled without the tree.
- **Zero filters** are accepted and return every placed visible audition.
- **Keyset.** On `(date dir, rank desc, tie, id)`, with `p_after = [date, rank, tie, id]`, the key of the last row served (`next`). For `recent`: `date < d or (date = d and (rank < r or (rank = r and (tie > t or (tie = t and id > i)))))`; for `ancien`, the date comparison is swapped. The cursor carries the tie it was cut at; it is never re-read from the lieu (changed in PR G's verification: re-reading it skipped the lieux between a lieu's old and new tie when its newest audition was unpublished between two pages). When a lieu's newest audition changes between two pages, its rows are taken by their new key; every row whose own key held is served once, none skipped or repeated.
- **`p_limit`** ≤ 100.
- **`p_through`** returns rows up to and including that audition (cap 2,000), plus `throughFound`.
- **First page only:** `total {auditions, lieux, n}` and `frame`, an exact port of `resultBounds` (`auditions.ts:94-116`, called at `apps/web/src/features/geo-nav/model/useCamera.ts:200`) over the result lieux' points:

```sql
pts as (select distinct lieu_id, plat as lat, plng as lng from hits),            -- lmd points, as the tree's lieux
c   as (select count(*) as c, case when count(*) >= 30 then floor(count(*) * 0.03)::int else 0 end as k from pts),
la  as (select lat, row_number() over (order by lat) - 1 as i from pts),
lo  as (select lng, row_number() over (order by lng) - 1 as i from pts),
b   as (select (select lat from la where i = c.k) as min_lat, (select lat from la where i = c.c - 1 - c.k) as max_lat,
               (select lng from lo where i = c.k) as min_lng, (select lng from lo where i = c.c - 1 - c.k) as max_lng from c)
-- frame = [min_lat - pl, min_lng - pg, max_lat + pl, max_lng + pg],
--   pl = greatest((max_lat - min_lat) * 0.08, 0.004), pg = greatest((max_lng - min_lng) * 0.08, 0.004)
```

#### 4. `testimony_page`

`testimony_page(p_audition uuid, p_filters jsonb default '{}', p_after jsonb default null, p_limit int default 50) returns jsonb`

- Returns `{testimonies:[{id, audition_id, person_name, person_info, content, topics, verification_status, created_at}], next}`.
- The audition must be published, and the online rule applies.
- The same filters apply as on the page (`apps/web/src/features/geo-nav/GeoNav.vue:69`, `apps/web/src/features/temoignages/TemoignagesExplorer.vue:65`).
- Order and keyset: `(coalesce(created_at, '-infinity') asc, id desc)`, from the facts index prefix. `p_limit` ≤ 100.

#### 5. `place_facets()`

- Returns `{themes:[{i, n}], dates:[min, max]}`.
- `themes` is `buildTopicOptions` (`filters.ts:155-165`) minus D1, over visible testimonies of published auditions, placed or not.
- `dates` is `dateBoundsOf(ownGroups)` (`useTestimonyFiltering.ts:104-106`).

#### 6. `admin_audition_filter(p_filters jsonb, p_reachable_by uuid default null)`

Only the `verified`, `mask` and `like` keys are accepted (22023 otherwise). Called only after `requireAdmin`.

```sql
-- executed with the active fragments: <all> = filter_sql(p_filters), <no_text> = filter_sql(p_filters - 'like')
select jsonb_build_object(
  'matches', coalesce((select pg_catalog.jsonb_object_agg(audition_id, pg_catalog.jsonb_build_array(n_all, n_no_text))
    from (select t.audition_id,
                 count(*) filter (where true <all>)::int     as n_all,
                 count(*) filter (where true <no_text>)::int as n_no_text
          from public.testimonies t
          where t.audition_id is not null                     -- every status, as admins see them (B:836-856, B:904)
          group by t.audition_id
          having count(*) filter (where true <no_text>) > 0) x), '{}'),
  'themes', (select pg_catalog.jsonb_build_array(count(*) filter (where t.theme_mask & 1 <> 0), /* … */
                                                 count(*) filter (where t.theme_mask & 32768 <> 0))
             from public.testimonies t join public.auditions a on a.id = t.audition_id
             where $7 is null or a.created_by = $7))              -- reachable (useAdminAuditions.ts:33-36)
```

Admins see every testimony under RLS, so `service_role` gives the same set as `fetchFilterableTestimonies` (`testimonies/service.ts:78-95`).

#### 7. The statement bound and the closing grants

```sql
do $$ begin
  alter role service_role set statement_timeout = '5s';
exception when insufficient_privilege then
  raise notice 'service_role statement_timeout left as is: %', sqlerrm;
end $$;
notify pgrst, 'reload config';

revoke all on all functions in schema ac from public, anon, authenticated;     -- B1 rule 6
grant execute on all functions in schema ac to service_role;
```

### B6. Grants summary

| Object | anon / authenticated | service_role |
|---|---|---|
| New `testimonies` columns | no column grant (keep the 9) | all |
| Schema `ac` and its functions | no usage, no execute (default privileges + closing revoke) | usage + execute |
| `geo_units` | revoked; RLS on, no policy | select, insert, update, delete |
| `placement_support`, the 7 read RPCs, `admin_audition_filter`, new `submit_online_testimony` | revoked | execute |
| New `auditions` columns | readable (table `GRANT ALL`, `B:1232`) | — |

### B7. CI database checks

These run in "Database from scratch" (`.github/workflows/ci.yml:44-121`) as `npm run db:check` (`tsx scripts/db-checks/index.ts`, shelling out to `psql`).

1. **Lint can fail.** `supabase db lint --level error --fail-on error` (today `ci.yml:109` cannot fail the job).
2. **Grant guard.**
   - anon and authenticated SELECT exactly today's 9 testimonies columns;
   - `geo_units` is not readable by them;
   - the functions they can execute equal `scripts/db-checks/allowlist.json` (today's set);
   - no `ac.*` function is executable by them (`has_function_privilege`, which ignores USAGE);
   - every SECURITY DEFINER function sets `search_path`, **except** the 8 baseline functions listed under `securityDefinerWithoutSearchPath` in the allowlist (`get_audit_log`, `get_pending_registrations`, `get_user_roles_with_details`, `has_role`, `insert_audit_log`, `is_admin`, `is_super_admin`, `verify_testimony`). Hardening those is a separate, reviewed PR outside phase 1: `is_admin`/`has_role` sit in old-app RLS.
3. **Derived parity (B).**
   - `themesOf`, `themesApproximate`, untagged and `fold(name info answersText(content))` are compared with the columns over every seed row plus a generated edge fixture:
     - every grid name and BY_KEY key in case, accent, NBSP, U+202F, BOM and curly-quote variants;
     - Kelvin K, a lone `\r`, questions out of order, quoted question lines, empty answers, text before the first question;
     - Œ, Æ, ẞ, İ, final sigma, Cyrillic, Arabic, emoji, 20k characters.
   - Zero `derive_version = -1`.
4. **Old-app-shaped writes (B, extended in C).** Inside `begin … rollback`, as `set local role authenticated` with `request.jwt.claims` naming a fixture admin:
   - testimony inserts with and without topics, then content and topics updates: columns filled;
   - `verify_testimony_by_token` with `p_edits`: `search_text` recomputed;
   - audition insert with location only: `place_stale`;
   - unchanged location resend: not stale;
   - changed location: stale;
   - as `service_role`, the 11-argument `submit_online_testimony` works and its bucket is stale;
   - the full call places the bucket.
5. **Migrate on top of seeded data (B, assertion extended in E).**
   - `supabase db reset --version 20261024234316 --no-seed`;
   - load `SEED_SHAPE=legacy` output with psql;
   - `supabase migration up --local`.

   Then assert:
   - every testimony has `derive_version = 1`;
   - the offline rows whose location is listed in `backfill_places_fr.expected.json` are placed exactly as listed (empty list before E);
   - every other offline audition is stale;
   - re-running M3's file with psql changes nothing.

   Finally `supabase db reset`. Verify the CLI 2.75 flags in PR B.
6. **RPC parity (G).** See B7a.
7. **Path integrity (C, F).** Every `place_path` equals the `geo_units` parent chain of `place_unit`.
8. **Backfill fixture (E).** In a rolled-back transaction:
   - listed rows are placed;
   - a changed row is skipped and stays stale;
   - online rows get `lieu_key = location`;
   - a second run changes nothing.

EXPLAIN plans are recorded in PR descriptions, not gated.

#### B7a. The frozen-client RPC parity harness (G)

**Inputs.**
- `scripts/parity/legacy/` holds frozen copies of today's pure client code:
  - `useTestimonyFiltering`'s `filteredTestimonies` and `filteredOwnGroups`;
  - `buildGeoHierarchy` (with `placeLabel`) and `applyBoundaries`' span;
  - `buildUnitStats` and `analyseScope`;
  - `buildLocationTree`, `buildTopicOptions`, `dateBoundsOf`;
  - `bySort`, `groupOwnAuditions`, `resultBounds`;
  - the admin `passes` and `topicOptions` (`useAuditionFilters.ts:113-141`).
- The corpus is exported as anon (drafts dropped, D1), plus the admin view as service_role.
- LocationGroups come from stored columns through D's pure `groupsFromRows()`, which carries `unitPath` and `lieuId`.

**What is compared.** Every RPC, over a matrix:
- filters: none; verified; each theme; needles of 1, 2 and 3+ characters (common, rare, accented, with `%` and `_`); a date range; a unit; a lieu; combinations;
- outputs:
  - every unit's count, child order and bbox;
  - facts for **every** unit of a complete response;
  - lieu lists, embedded lieu audition lists, and **lieu labels** (`placeLabel(key, city)`);
  - result pages with `limit = 7` (complete, no duplicates, same order), each row's lieu point;
  - `through=`; testimony pages; facets; `resultCount`; frame;
  - the admin list's passing set and theme options for a super admin and for a plain admin, over every content-filter combination, with needles found only in an audition's title, location or content.

Only D1 and D14 (rows the job has not re-placed yet) may differ, each listed; every order must match. The harness stays after Q as a regression test.

### B8. Escape hatches

Designed now, built only if P misses its targets.
- `audition_rollups(audition_id pk, n_public, themes int[16], base, untagged, approx)`, maintained by statement-level AFTER triggers with transition tables; RLS on, all revoked.
- Denormalised `place_path` on testimonies (A1).

---

## C. Gazetteer

### C1. France: no file in phase 1

France is resolved through `frChain` (A13). The world `index.json` lists `FR` with `source:"insee"` and no chunk.

### C2. World build (PR M)

`scripts/map-data/build-gazetteer.sh` (DuckDB plus a Node writer) runs **on the laptop**, after PR #110's `build-boundaries.sh`, with the same `RELEASE` and one shared build id.

**Inputs.**
- A persisted light pass over Overture `type=division` into `raw/overture-divisions.parquet`. Columns: `id, subtype, class, country, region, parent_division_id, names.primary, names.common['fr'|'en'], population, wikidata` and the point geometry (label point). Today the division table is read only in memory (`WT:scripts/map-data/overture.sql:26-30`).
- `raw/overture-areas.parquet`, for `poly` and the bbox.
- `raw/depth-per-country.csv`, for the per-country ladder.

**Steps.**
1. Drop `country IN ('FR', OVERSEAS)` (`WT:build-boundaries.sh:98-99`).
2. Keep polygon units, plus point-only localities with `class in ('megacity','city','town')` or population ≥ 1,000 (A14).
3. **Ancestor closure:** add every ancestor of a kept row (`poly = false` when it has no area).
4. Label = `coalesce(names.common.fr, names.common.en, names.primary)`; keep `primary` as `alt`.
5. Parent = `parent_division_id`; country and dependency ids become their ISO code.
6. Write the chunks and the per-country search index.
7. Write a size report and enforce the caps (A14).

### C3. Layout, fields and sizes

Under `gazetteer/<build>/`, with `build = ov-2026-10-21.0`:

| File | Content |
|---|---|
| `index.json` | `[{cc, name_fr, ladder:[levels present], lat, lng, bbox, chunks:[adm1 ids], search:true}]`; FR as `{cc:"FR", source:"insee"}` |
| `<CC>.json` | Admin levels above locality (with, for each region row, the index of the chunk holding its localities), plus all localities when the country has ≤ 8,000 rows |
| `<CC>/<n>.json` | Big countries: the localities of region number `n` in `chunks` |
| `<CC>.search.json` | `{cols:["f","c","i","p"], rows:[[folded name and alt, chunk index (-1 = <CC>.json), row index, population]]}`, sorted by population desc; about 25 bytes per row |

Rows are columnar: `{"cols":["id","parent","level","name","alt","lat","lng","pop","poly","chunk"],"rows":[…]}`, coordinates rounded to 5 decimals.

**Sizes.** Polygon rows alone, measured: 631 files, 80.8 MB raw / 26.8 MB gzip, largest 1.6 MB. M's report adds the point localities, the search indexes and the totals against the caps (≤ 9,000 files, ≤ 60 MB gzip).

### C4. Hosting

**Phase 1.**
- **Build and publish from the laptop.** `npm run gazetteer:build`, then `scripts/map-data/publish-gazetteer.sh`. It tars, runs `gh release create gazetteer-<build>` and writes `data/gazetteer.lock.json` = `{build, asset, sha256, previous}`.
- **Both deploy workflows** add `data/gazetteer.lock.json` to their `paths:` (today `deploy-staging.yml:11-17` and `deploy-staging-web.yml:11-16` do not watch it), so a lock bump redeploys web and API together.
- **Download.** Workflows use `gh release download` with `GH_TOKEN: ${{ github.token }}` and `permissions: contents: read`; the repo is private, so plain URLs fail. They verify the sha256.
- **Web.** Extracts the current and the `previous` build into `apps/web/dist/geo/<build>/`. It **appends** to the existing `_headers` (`deploy-staging-web.yml:84` writes it with `>`): `/geo/*` → `Cache-Control: public, max-age=31536000, immutable`. Two builds of ≤ 9,000 files plus about 100 site files stay under 20,000.
- **API.** Extracts the current build into `apps/api/data/geo/<build>/` before `docker build`.
- **Release skew.** `wrangler.jsonc:14` serves `index.html` with 200 for a missing path (SPA fallback). The client therefore checks `content-type: application/json`. HTML means skew: it reloads `index.json` once, then shows "La liste des lieux a été mise à jour : rechargez la page."
- **Local dev.** `npm run gazetteer:fetch` uses the developer's `gh` auth (gitignored output).

**Phase 2.** The same files on R2. The web reads `VITE_GEO_BASE`; the API keeps its baked copy.

### C5. How the API validates a pick

`apps/api/src/modules/places/gazetteer.ts` reads `index.json` at boot and loads chunks on demand (LRU ≤ 16 MB, A19).

`resolveGazetteerPick({country, unit_id, chunk})`:
1. Loads `<CC>.json` and, when `chunk ≥ 0`, that one region chunk. It never scans the other chunks.
2. Finds the row. If it is missing from either file → 409 "Lieu à re-choisir" (release skew or a forged chunk).
3. Checks the level is allowed (A15).
4. Walks parents to the ISO root (all ancestors are in `<CC>.json` or the same chunk, by closure).
5. Sets `locality_id` to the first localadmin or locality on the path.
6. Takes the point from the label point; client coordinates are never trusted (`townHall.ts:5-8`).
7. Upserts the chain into `geo_units` root first: `source='overture'`, `polygon = poly`, `geo_release`.

### C6. Matching the phase-2 tiles

PR M carries these PR #110 changes, before any non-French id is stored:
1. Régions get `parent = 'FR'` (`WT:build-boundaries.sh:197,203`).
2. Country and dependency features get `id` = their ISO code. The 13 French overseas top polygons get `id = 'FR'`, `country = 'FR'`, with `iso = <code>` kept for drawing.
3. Fix the step that deletes `$OUT/tiles` (`:148`) after `:115` created it.
4. One build id names tiles and gazetteer.
5. Rebuild the archive: the cached one lacks `fr:com:6938x`.

**`scripts/map-data/check-gazetteer.ts`:**
- every parent resolves, with no cycles;
- no FR row;
- caps hold;
- decoded spot tiles at z6, z8 and z10 have ids equal to gazetteer ids **for non-French units**;
- French tile ids (`fr:com:69387` under `fr:com:69123`, `fr:dep:2A`, `fr:reg:01`) are checked against the Etalab inputs and the seed's `fr-units.json`.

**Phase-2 join.**
- `promoteId` per layer (none today, `WT:apps/web/src/features/map/dev/pmtiles.ts:86`).
- `setFeatureState({sourceLayer: level === 'dependency' ? 'country' : level, id})`. Dependencies ride in the `country` layer (`WT:build-boundaries.sh:155-158`), and the tiles are built per `LEVELS` (`:73,266`).
- A unit with `polygon = false` lights its nearest ancestor with a polygon.

### C7. Remap (phase 2, designed now)

**Matching.** For each `geo_units` row from an older release, the job resolves the id in the new release:
1. by id;
2. else by `wikidata`;
3. else, **for `level = 'region'` only**, by `(country, ISO 3166-2)`. Counties and below carry their enclosing region's code, so this match would be wrong for them.
4. else by point-in-polygon of the stored audition points.

**Repointing**, in one transaction per moved unit `old → new`:

```sql
insert into public.geo_units (…) values (new, …) on conflict (id) do nothing;     -- new may already exist (merge)
update public.geo_units set parent_id = new where parent_id = old;                 -- children
update public.auditions a set
    place_unit  = case when a.place_unit = old then new else a.place_unit end,
    place_path  = pg_catalog.array_replace(a.place_path, old, new),
    locality_id = case when a.locality_id = old then new else a.locality_id end,
    citycode    = case when a.audition_en_ligne and a.citycode = old
                        and not exists (select 1 from public.auditions b            -- never collide with a bucket
                                        where b.audition_en_ligne and b.citycode = new and b."date" = a."date")
                       then new else a.citycode end,
    geo_release = <release>
  where a.place_path @> array[old];                                                -- leaf and path in one row update
delete from public.geo_units where id = old;
```

- Each row update sets leaf and path together, so the CHECK holds row by row.
- A merge of two old ids into one new id is two passes.
- A colliding online bucket keeps its old `citycode` as its key for that month; later submissions use the new id.
- `lieu_id` changes for lieux under a moved leaf (A3). The job bumps every cache generation and writes a report.
- French codes change every 1 January, mapped from INSEE's table de passage. Measured stability Sep → Oct 2026: localities 99.73%, regions 100%.

---

## D. API

### D1. Endpoints

All public GETs are `no-cache` with ETag/304 through `sendCached` (`apps/api/src/lib/httpCache.ts:16-67`).

| Method, path | Params | Source | Response | Cache family |
|---|---|---|---|---|
| GET `/api/places` | `unit` or `units` (≤ 50), `depth` 1–3 (default 2), `facts=1`, `empty=1` (no filters only), `budget` (`TEST_TOOLS` only) + filters | `place_counts_many` | `PlaceCounts` for `unit`; `{results: PlaceCounts[]}` for `units` | `places` (per unit) |
| GET `/api/places/lieu` | `id` (lieu id), `sort` + filters | `lieu_auditions` | `{lieu, auditions}` | `lieu` |
| GET `/api/places/results` | filters (zero allowed), `sort`, `after`, `limit` ≤ 100, `through` | `audition_results` | `{total?, frame?, auditions, next, throughFound?}` | `results` (first page, no `through`) |
| GET `/api/places/facets` | — | `place_facets` | `{themes, dates}` | fixed key |
| GET `/api/auditions/:id/testimonies` | content filters, `after`, `limit` ≤ 100 | `testimony_page` | `{testimonies, next}` | `tpage` (first page) |
| GET `/api/auditions/admin/filter` | `v`, `t`, `q`; `requireAdmin` | `admin_audition_filter` | `{matches: {[id]: [nAll, nNoText]}, themes: number[16]}` | not cached |
| POST `/api/admin/places/sweep` | `dryRun=1`; super admin | placement job | `{placed, unplaced, failed, rulesRestamped}` | — |

- A `units=` response is assembled from per-unit cached JSON buffers, its results in the order asked. Its ETag is a hash of the per-unit ETags (so each order is its own ETag and its own entry: the order is the body's). A client that holds that ETag is answered 304 before anything is assembled. Otherwise the assembled bytes and their gzip are kept under that ETag in a family of their own, `assembled` (D3), never beside the per-unit answers: however many assemblies there are, they only evict one another, never an answer that costs a database call. Each is built once, not per request, through a gate of its own (4 at a time, 50 more waiting up to 5 s, then 503 "Réessayez dans un instant." with `Retry-After: 1`). A build that reaches no database costs its visitor one miss: taken before (a 429 past the limit, as any miss), given back when the gate refuses the build. An answer with `textIgnored` is kept the same way.
- The module is `apps/api/src/modules/places`, registered beside the others (`apps/api/src/server.ts:122-133`).
- `GET /api/auditions/:id` (`apps/api/src/modules/auditions/routes.ts:45-60`) stays whole.

### D2. Filters, needle and keys

`packages/shared/src/placeFilters.ts` is used by web and API.

| Param | Meaning | Validation |
|---|---|---|
| `v=1` | verified only | — |
| `t=<csv>` | `AUDITION_THEMES` indexes → `mask` | 0..15 |
| `q=<text>` | free text | ≤ 200 chars |
| `from`, `to` | date range | `YYYY-MM-DD` |
| `u=<csv>` | unit ids | ≤ 50; `^([A-Z]{2}\|fr:(reg\|dep\|com):[0-9AB]{2,5}\|[0-9a-f-]{36})$` |
| `l=<csv>` | lieu ids | ≤ 50; `^l:[0-9a-f]{16}$` |

- **Parsing.** zod `safeParse`, then `reply.badRequest(first issue)` (`auditions/routes.ts:66-69`).
- **Needle.** `needle = fold(q.trim())` (`useFilters.ts:21`). Empty means no text filter. Below `SEARCH_MIN_CHARS` the text is ignored and the response says `textIgnored: true`. `like = '%' + escapeLike(needle) + '%'`.
- **Canonical filter key.** `v1|v0|m<mask>|q<needle>|f<from>|t<to>|u<sorted>|l<sorted>`, built **after** the min-length rule. The web uses the same function for its query keys and to decide list mode (E1).
- **Cache keys.** `places|<unit>|d<depth>|x<facts>|e<empty>|b<budget>|<fkey>`, `lieu|<id>|<sort>|<fkey>`, `results|<sort>|<fkey>`, `tpage|<audition>|<fkey>`.

### D3. Caches and memory

**`CacheFamily({name, maxBytes, ttlMs, staleForMs})`** in `lib/cache.ts`:
- its own Map, single flight per key, SWR;
- pre-gzip and ETag reused from `cachedResponse` (`lib/cache.ts:113-143`);
- entry bytes = `json.length + gz.length`;
- LRU by bytes;
- one generation per family;
- a value heavier than an entry may be (a quarter of its family's budget unless the family sets its own) is served but not cached.

| Family | Budget (Buffers) | Entry ≤ | TTL / SWR |
|---|---|---|---|
| `places` (per unit; the facets) | 18 MB | 4.5 MB | 60 s / 5 min |
| `assembled` (`units=` batches and `textIgnored` answers, built from cached answers, D1) | 10 MB | 6 MB (a 4 MB batch and its gzip) | 10 min / 5 min |
| `lieu` | 6 MB | 3 MB | 60 s / 5 min |
| `results` (first pages) | 8 MB | 2 MB | 60 s / 5 min |
| `tpage` (first pages) | 8 MB | 2 MB | 60 s / 5 min |
| `audition` (moves `audition:<id>` here, `publicCache.ts:20-37`) | 4 MB | 1 MB | 60 s / 5 min |
| `legacy` (`/api/auditions`, `/api/map`, `/api/testimonies` values) | 20 MB | 16 MB; heavier refused (503, remembered for the TTL) | today's TTLs |

**Process budget (A19).**
- heap `--max-old-space-size=256`, the boundaries LRU's ≤ 32 MB of parsed values within it (replaces the unbounded Map at `boundaries/service.ts:41`);
- families ≤ 74 MB (64 MB of answers, 10 MB assembled from them);
- gazetteer LRU ≤ 16 MB.

`/api/health?details=1` on staging reports them.

**Invalidation.**
- `invalidatePublicCaches()` (`publicCache.ts:49-53`) also bumps every family.
- Existing call sites stay: `auditions/service.ts:353,442,448,497,503`; `testimonies/service.ts:169,312,382,452`; `verification/service.ts:181,223`.
- Added: the placement job after a pass that wrote anything; the remap.
- Old-app, seed and SQL writes converge within the TTLs.

### D4. DB gate, timeouts, errors, rate limits, timing

- **`lib/dbGate.ts`.** At most 6 concurrent RPC calls, a queue of 50, a 5 s wait, then 503 "Réessayez dans un instant." (never cached). A slot is released when its call settles. After an abort, the slot is held 5 s more (A11).
- **Batching.** A `units=` miss set is split into RPC calls of ≤ 20 units. Each call takes one gate slot and counts as one miss. A call whose answer passes the 2 MB read cap is made again unit by unit (the extra calls charged to the visitor afterwards), so only a unit whose own answer passes 2 MB is refused, cold or warm.
- **Timeouts.** Every RPC call uses `.abortSignal(AbortSignal.timeout(7000))`; `service_role` is bounded at 5 s (M4).
- **Errors.**
  - Postgres `57014` → 503 "Recherche trop large : précisez-la.", never cached; a stale value is served if held.
  - AbortError, PGRST000-003, `42P05`/`26000` (prepared statements), connection codes, a gateway's 5xx, a fetch that threw → 503 "Réessayez dans un instant.", never cached; a stale value is served if held.
  - `22023` → 400.
- **Rate limits** (`apps/api/src/lib/rateLimit.ts:26,59`, keyed by `clientKey(visitorIp(req))`, `apps/api/src/lib/visitor.ts:13-17`):
  - `':places-miss'`: 30 RPC calls per 10 s;
  - `':search'`: 20 misses per 10 s when `q` is set.

  A refusal is 429 with `Retry-After` (seconds to the window's end). The web retries ensures with backoff (E2). With batching, one drill step costs 1–3 RPC calls.
- **`RATE_LIMITS=relaxed`** (refused unless `APP_ENV=staging`) multiplies these and the online-submission limits (`online-testimonies/routes.ts:25`, `online-testimonies/service.ts:147`) by 100 for the load campaign.
- **Timing.** `Server-Timing: cache;desc=hit|stale|miss, db;dur=…, gate;dur=…` and `X-Cache`.

### D5. Write paths (PR D)

#### `frChain(insee)` (`modules/places/fr.ts`)

It calls `fetchCommune` (moved from `townHall.ts`) and returns `{units, path, unit, localityId}`:
- path = `FR` → `fr:reg:<region.code>` → `fr:dep:<departement.code>` → `fr:com:<codeParent ?? code>` [→ `fr:com:<code>` for an arrondissement];
- names come from geo.api `nom`, with arrondissement labels from `arrondissementFromCitycode`;
- a COM is chained `fr:reg:<dep>` → `fr:dep:<dep>`.

`fetchDepartement(code)` and `fetchRegions()` serve département- and région-level lieux. `upsertGeoUnits(units)` writes through `adminClient`, root first. The Paris/Lyon/Marseille and `SHARED_MAIRIE` tables move into `packages/shared/src/frSplitCities.ts`, replacing `match.ts:117-161`, `townHall.ts:18,25-37,111-116`, `CommuneCombobox.vue:34-38` and `hierarchy.ts:11-15`.

#### `placeLieu(location, opts?)` (`modules/places/placeLieu.ts`)

Returns `Placement | 'retry'`:
1. **Generic text.** If `opts.pick` is not a gazetteer pick: `key = getCanonicalLocation(location)`, and `isGenericLocation` → `unplaced` (`geocode.ts:272-276`).
2. **Gazetteer pick** (`opts.pick.kind === 'gazetteer'`, N): `resolveGazetteerPick`, `key = normalizeLocation(location)`, point = label point, precision `locality`. **No reuse.**
3. **Admin BAN pick** (`opts.pick.kind === 'ban'`):
   - units from `frChain(pick.citycode)`;
   - point = `getKnownCoordinates(key) ?? pick` (a curated lieu keeps its curated point);
   - precision `address` for housenumber, street and locality, `commune` for municipality;
   - sanity check: within 30 km of the commune centre, else fall through to step 5.
   - **No reuse** (D12).
4. **Reuse (text-only).** If a placed, non-stale French offline row has `lieu_key = key` (`auditions_lieu_key_idx`), copy its unit, path, locality, point, precision and `place_candidates`.
5. **Today's pipeline.** `resolve(key)` (`geocode.ts:267-330`: curated rule plus reverse BAN, `locate()`, BAN throttle `:178-200`; the disk cache stays as its memo).
   - `GeoEntry` → `frChain(entry.citycode)`, or `fr:dep`/`fr:reg` chains for département and région levels. Point: `getKnownCoordinates(key) ?? entry.coords`.
   - `Homonyms` → `pickHomonym(v, placement_support())`. Settled → placed with `place_candidates`. Unsettled → `unplaced` with candidates.
   - `null` → `unplaced`.
   - A BAN or geo.api failure → `'retry'`.

Every placement stores `placed_location = location` and `placed_rules = RULES_HASH`, where `RULES_HASH` is the first 8 hex of the sha256 of `JSON.stringify(LOCATION_RULES)`.

#### Online submission (`online-testimonies/service.ts:120-170`)

- **France.** `resolveTownHall` (`townHall.ts:145-172`) also returns `pointKind` and `frChain(key)`. Precision is `address` for a mairie point, `commune` for a centre. Then `upsertGeoUnits` and `submit_online_testimony` with the place arguments.
- **Elsewhere** (N, behind `ONLINE_WORLDWIDE`): `resolveGazetteerPick`, `citycode = place_unit`, `location = "<Ville> (<Pays>)"`, branched wording.
- **Schema.** `onlineTestimonySchema` gains `place: {country:'FR', commune_code} | {country, unit_id, chunk}`. Bare `commune_code` stays accepted for one release (`schemas.ts:66-71`).

#### Admin create and edit (`auditions/service.ts:299-360, 403-460`)

- **Schemas.** `createAuditionSchema` and `updateAuditionSchema` gain an optional `place: {kind:'ban', citycode, lat, lng, type} | {kind:'gazetteer', country, unit_id, chunk}`. `location` gets `.max(300)`.
- **Create.** Places inline within a 3 s budget, keeping `geocodeBriefly`'s promise (`:349`). It upserts the units, then inserts with the place columns. On `'retry'` or timeout the row is inserted stale.
- **Update.** Re-places when the location or the pick changed, or the row is stale. Online rows keep their place (`:420-427`). A non-French row edited without a new pick keeps its unit (A7).

#### The re-placement job (`modules/places/placementJob.ts`)

- **When.** Single flight. Boot + 10 s, every 10 minutes, and 2 s (debounced) after any admin audition write.
- **No service role:** it logs a warning and does nothing.
- **Rules pass, once per boot.** It pages placed French offline rows with `placed_rules is distinct from RULES_HASH`:
  - if the canonical or known point changed, `placed_location = NULL`, guarded by `.eq('id').eq('placed_location', old)`;
  - otherwise it stamps `placed_rules`.
- **Each pass.**
  - Pages `adminClient.from('auditions').select('id, location, audition_en_ligne, citycode, place, place_path').eq('place_stale', true).order('created_at').limit(25)`.
  - Online rows: `frChain(citycode)` (or the stored non-French unit), point from `place`, `lieu_key = location`.
  - Non-French offline rows with a stored path: keep the unit and point; `lieu_key = normalizeLocation(location)`.
  - Other offline rows: `placeLieu` (text-only).
  - Writes with `.eq('id', id).eq('location', usedLocation)`, so a concurrent edit is never overwritten.
  - Backs off on `'retry'`.
  - On 10-minute passes it also retries `unplaced` rows with candidates (support only).
  - Calls `invalidatePublicCaches()` when it wrote anything.
- **Cutover.** `POST /api/admin/places/sweep?dryRun=1` reports, then applies. Then, before L's web reaches production, its API runs with `MAP_SOURCE=db` and `PLACEMENT_JOB=true`: the map reads stored places alone from L on, and only the job brings it the old app's writes and a `LOCATION_RULES` change (D14). Without it, a production API logs a warning at boot.

### D6. `/api/map` and the admin list from stored places (PR D, `MAP_SOURCE`)

- **Reads.** Audition rows (with the new columns) still come through `publicClient` (`auditions/service.ts:69-73`) or the caller's client (`:192-199`). `geo_units` names and codes come through **`adminClient` only**: the table is revoked from anon and authenticated, with RLS and no policy.
- **Without a service-role key**, `MAP_SOURCE=db` falls back to the geocoder build and logs a warning.
- **`/api/map`.** A pure `groupsFromRows(auditions, geoUnits)`:
  - `canonicalName = lieu_key`;
  - coordinates from the newest audition;
  - `city`, `citycode`, `arrondissement`, `departementCode`, `departementName` and `region` from the path's units. Online rows keep `place.commune` etc. (`locationGroups.ts:63-74`).
  - groups in the same insertion order.
- **Stale rows** fall back, one by one, to today's geocoder path.
- **`LocationGroup`** additively gains `unitPath` and `lieuId`.
- **The admin list** (`fetchAdminAuditions`, `auditions/service.ts:191-249`) takes `area` from the same data. The background resolve (`:205-212`) goes.

  | Row | `placement` |
  |---|---|
  | stale | `pending` |
  | `unplaced` | `unplaced`, with candidates |
  | address | `address` |
  | commune / departement / region | as stored |
  | online | always `address` (`:227`) |

- **Staging diff.** With `TEST_TOOLS`, `?source=geocoder` serves the other build.

### D7. Early wins (PR A)

- `fetchPublishedAuditions` (`auditions/service.ts:68-74`) and `fetchAdminAuditions` (`:194-199`) page with `.order('date',{ascending:false}).order('id').range()`.
- The corpus leaves the boot prewarm (`apps/api/src/prewarm.ts:27-35`).
- `CMD node --max-old-space-size=256 …` (`apps/api/Dockerfile:46`).
- New tests go into the list at `apps/api/package.json:11`.

### D8. What retires, what stays, and the whole-table guards

**Retires.**

| What | PR |
|---|---|
| Read-time placement in `/api/map` and the admin list (`geocode.ts:128-135`) | D |
| The warm pass and its boot call (`locationGroups.ts:102-172`, `index.ts:25`) | D |
| `geocodeBriefly` | D |
| `/api/map` polling (`apps/web/src/features/temoignages/api/queries.ts:31-48`) | L |
| The corpus on the map page | L (serveur mode stops fetching it in K) |
| `/api/testimonies/admin/filterable` | Q, after the admin parity check |
| `/api/map` and the geocoder fallback | Q |

**Stays.**
- `match.ts`, `geocode.ts` and the BAN disk cache, as the engine for the job and the backfill. `BAN_BASE_URL` becomes config.
- `townHall.ts`, extended.
- `boundaries/` and `dem/`.

**Whole-table guards (H).** These answer 503 "Liste trop longue : utilisez /api/places." and cache nothing above a threshold, so they only bite at staging scale until prod grows. A refusal is remembered for the key's TTL (or until a write): one count per TTL, and a value held from before is not served past it:
- `/api/testimonies` (`testimonies/service.ts:52-71`): exact head count through **`adminClient`**, 503 above 25,000. A count as anon takes 32 s at 300k (§0.1). A count error or 57014 also gives 503 (not remembered).
- `/api/auditions` and `/api/map`: head count of published auditions through `adminClient`, 503 above 5,000. Below that, their values live in the byte-bounded `legacy` family, not the unbounded store (`auditions/routes.ts:22-33`, `lib/cache.ts:71`).

**Deploy check.** `deploy-staging.yml:135` stops curling `/api/auditions` (a whole-table pull) and curls `/api/places/facets` as the Worker instead, which also proves the service-role key. `deploy-staging-web.yml`'s check through the site's Worker does the same (L).

---

## E. Web

### E1. Seams that change

| Seam (file:line) | Today | Phase 1 (PR) |
|---|---|---|
| Id parsing: `geo/boundaries.ts:8-12` (`depCodeOf`), `geo-nav/model/useGeoHierarchy.ts:92` (`startsWith`), `geo-nav/model/useScope.ts:86-95` (parent walk), `map/lib/polygon.ts:280-284` (plateau height) | Name-path ids | `GeoUnit` gains `geoRef?: {country, level, code?, nom?}`, `heightClass`, `ancestors`. Ancestry by those; ids become opaque. `scopeStats.ts:169-174,197` keeps legacy parsing until Q. (I) |
| French geometry: `useGeoHierarchy.ts:48-62` (country → métropole at `:51-53`; régions/départements by `nom`), `raisedGeometryFor`, depFine, `useMapFeed.ts:101,109` | Returned for any unit of that level | Every French source is gated on `geoRef.country === 'FR'` (country: `code === 'FR'`), matched by code when set. Otherwise `undefined` and "known absent", so `scopePending` releases. (I) |
| Hierarchy source: `useGeoHierarchy.ts:31-40` | `buildGeoHierarchy(groups)` | By source: `buildTreeFromUnits(store)` in `features/geo/treeFromUnits.ts` (pure) (J) |
| Corpus and map queries: `TemoignagesExplorer.vue:13-18`, `temoignages/api/queries.ts:17-48` | Always mounted | J: mounted in every mode (serveur uses them **for the lists only**). K: unmounted in serveur mode. L: gone from the page. |
| Filtering: `useTestimonyFiltering.ts:26-108` | Client over the corpus | Server mode emits `ServerFilters` plus the canonical key. `resultCount = root.self.n + root.unplaced.n`; `topicOptions`/`dateBounds` from facets; `locationTree` from `empty=1` rows with unit-id tokens. (J) |
| List mode: `TemoignagesExplorer.vue:70` (`:filtered="chips.length > 0"`), `GeoNav.vue:160` | Raw chips (`useFilters.ts:47`) | Server mode: `filtered` = the debounced canonical key is non-empty. Chips stay as today. A text below `SEARCH_MIN_CHARS` shows a hint, not list mode. (J) |
| Analyses: `analyses/composables/useScopeAnalysis.ts:83-87,92-110` | `buildUnitStats(groups, ownAuditions)`; memo reset on `stats !== analysisMemoOf` (`:99`) | Server mode: `analyses/stats/factsStats.ts` builds the index once per (filter key, store version). `analyseScope`, `reliabilityOf` and `coreOf` read a numeric `UnitFigures`. The memo is keyed by unit id plus a hash of its figures, so merges do not re-render plates. Concentration label = `placeLabel(largest.key, largest.city)`. (J) |
| Boot curtain and panel loading: `GeoNav.vue:108-128,563-565` | Keyed on the corpus | Keyed on the root `/api/places` query in server mode (J) |
| No-geometry hold: `useMapFeed.ts:96-114` | Holds forever | `false` when geometry is known absent (J, D7) |
| `api.get`: `shared/api/client.ts:60-61` | No signal | Forwards an `AbortSignal` and surfaces `Retry-After` (J) |
| Text field: `filters/FiltersDialog.vue:172-176` | Per keystroke | 300 ms debounce in server mode (J) |
| Lieu lookups: `useGeoHierarchy.ts:142-146` (`placeByCanonical`), `usePanelAuditions.ts:112-116,216-223`, `useMapFeed.ts:252-253` | By canonical name | `PanelAudition` gains `placeId`, filled from `placeByCanonical` in corpus mode and from `lieu.id` in server mode. Lookups use `index.get(placeId)`. (K) |
| Open lieu's auditions: `usePanelAuditions.ts:64-75` | Scans groups | Complete responses: the lieu's embedded `list` (synchronous). Lazy path: `useLieuAuditions(lieuId, fkey)`, with LoadingDots while empty (D13). (K) |
| Results: `usePanelAuditions.ts:77-109` | In memory; reveals 50 (`:86-90`) | `useInfiniteQuery(/api/places/results)`; `showMoreResults` → `fetchNextPage`. (K) |
| Results signatures: `usePanelAuditions.ts:119-129` (`resultsSig`, `resultSetSig`), watchers `:136-159` (scrollTop reset, `scheduleResultsFit`) | All result ids | `resultsSig = fkey\|sort\|first-page ids`; `resultSetSig = fkey\|total.auditions\|total.n`. Never the appended pages, so `fetchNextPage` neither scrolls nor re-fits. The "still matches" check runs `results?through=<open id>` only when the key or sort changes. (K) |
| Result count heading: `GeoNav.vue:577` (`:result-count="resultAuditions.length"`) | Loaded rows | `total.auditions` from the first page (K) |
| Opening a result: `usePanelAuditions.ts:216-223` (`toggleAud`), `useNavActions.ts:80-101` (`openResultAt`) | Lieu looked up by canonical in the tree | The row's `lieu{id,unit,path,lat,lng,city}`: the store inserts a stub lieu under its unit and ensures the path in the background, so selection, flight, halo and label work at once (K) |
| Testimonies of an audition: `GeoNav.vue:69`, `geo-nav/model/auditions.ts:34-80` | From the corpus | `useAuditionTestimonies(id, fkey)`, enabled when open; first page prefetched for the open lieu's auditions; `testimonies: null` while loading (`AuditionList.vue:94-100`) (K) |
| Result frame: `useCamera.ts:200` | `resultBounds(allPlaceUnits)` | The server's `frame` (K) |
| New-audition refresh: `app/AppDialogs.vue:33-40` | Invalidates corpus and map keys | Also invalidates `placesKeys.all`; the store rebuilds (L) |
| Map polling: `queries.ts:31-48` | 2.5 s until stable | Removed (L) |

### E2. Data flow on Témoignages (server mode)

**The store.** `features/geo-nav/data/useUnitTree.ts`:
- holds a plain, **non-reactive** `Map<unitId, {row, childIds?, lieuIds?, loaded}>` per filter key;
- keeps an LRU of the 4 most recent keys;
- bumps one `version` ref per merged response, like `useCommuneGeo.ts:64-68`.

Requests go through `queryClient.fetchQuery` with keys `[...placesKeys.all, fkey, unit, depth, facts]` (dedupe, abort). `features/geo-nav/data/placesApi.ts` holds the calls and exports `placesKeys`, which `features/temoignages/index.ts` re-exports for `app/`. `buildTreeFromUnits` gets a fresh `GeoUnit` tree. `GeoDrillMap`'s props and watcher order are untouched.

1. **Boot.**
   - Same chunks as today. Then, in parallel: `/api/places?unit=world&depth=2&facts=1`, `/api/places/facets`, and the boundary levels.
   - The curtain lifts on the root, métropole and régions (`GeoNav.vue:108-128`).
   - `FR` carries `METRO_FRANCE`/`FRANCE_CENTER`, so `flyToUnit(country)` frames as today (`GeoNav.vue:470-480`).
   - **The store always asks for facts**, so turning analyses on is synchronous at prod size, as today.
2. **Drill.**
   - New watchers after GeoNav's existing ones call `ensure([scope, scope.parentId])` on `currentScope.id`.
   - On `visibleInsee` (`useMapFeed.ts:259-273`) they ensure the visible commune and arrondissement units whose `loaded` is false.
   - `ensure` coalesces requests within a 50 ms window into **one** `units=` request (≤ 50 units).
   - On 429/503 it retries after `Retry-After`, or 1 s, 2 s, 4 s. After 3 failures the unit is marked `failed`: the panel's existing error line shows, with a retry on the next scope change.
   - A `loaded:false` unit gets `childrenPending`. `scopeForView` stops there (`geo/scope.ts:64-66`), and `UnitList` shows LoadingDots.
   - At prod, `complete` makes all of this a no-op.
   - `flyToUnit` stays synchronous; children's boxes come with the depth-2 response.
   - `crossRegionDeps` (`useMapFeed.ts:130-151`) reads the départements present in the country's response.
3. **Levels.**

   | Server row | Site level |
   |---|---|
   | country, dependency | country |
   | region | region |
   | county | dep |
   | locality whose parent is a locality | arr |
   | other locality, localadmin | city |
   | lieu | place |

   - `count = n`.
   - Bounds = padded point bbox (A12); `applyBoundaries` overrides with French geometry, matched by code, FR only.
   - `insee = code` for French city and arr.
   - **Lieu label = `placeLabel(key, city)`** (`hierarchy.ts:19-28`), with `city` from the lieu row.
4. **Filters on (a new key).**
   - The new store first requests the current chain in one batch: `units=[world, …ancestors(scope), scope]`, depth 2. When the previous key's root was complete, it requests only `world`.
   - The page swaps to the new store only once the scope and its parent are present, so the plateau neither sinks nor rises. The previous tree stays on screen meanwhile (D6).
   - List mode takes its pins from the same tree under the filter, its frame from `results`, and its list from `results` pages.
5. **Analyses on.**
   - Figures for the scope come with its own response (self) or its parent's (children).
   - When complete, every unit's figures are already present.
   - On the lazy path, a deep jump shows the previous figures or nothing, per "Analyses en attente".
6. **Invalidation.**
   - AppDialogs' `onAuditionCreated` calls `reloadPlaces` (`geo-nav/keys.ts`, L): it invalidates `placesKeys.all` (the lists on screen refetch through their observers) and tells the store directly. Debounced 100 ms, the store drops every per-key store, takes their answers out of the query cache, and reloads the current chain under the current key, swapping as in step 4. The comparer forgets the result pages it read.
   - Not the QueryCache's `invalidate` events, as first designed: TanStack sends none for a query already invalidated — one whose last read failed, or a reload still on its way — so a second creation would go unread (L's review).
7. **Home card.** `/api/places?unit=world&empty=1` reproduces `/api/map`'s groups, including zero-testimony auditions. The boot prewarm fills it beside the root with facts and the facets (L).
8. **Filter dialog place tree.**
   - Built from `empty=1` rows. A country level appears only with more than one country.
   - Arrondissements are flattened into their commune (`filters.ts:96-151`), per "Arbre des lieux".
   - Lazy children at scale: `LocationMultiSelect` gains `loadChildren` (L2). A unit whose children are not all known (not loaded, or, flattened, an arrondissement not loaded) is a `lazy` node with no children. Opening it asks the store for its own answer (`loadEmpty`: `units=` batched, `empty=1`, retried as the map's reads); LoadingDots and `aria-busy` meanwhile, a failure line with "Réessayer" after the retries. A whole tree (production's) has no lazy node and asks for nothing.
   - Search on an incomplete tree matches what is loaded, and says so ("La recherche ne voit que les zones déjà dépliées…"). It loads nothing: there is no unit-name search, and asking for every unopened région would read all their communes at each search (megabytes at scale, and a slice of the visitor's miss limit) while still missing the lieux below the communes.
   - The comparer compares the loaded part: a lazy node itself, not its children (`placeTreePending`). `__acComparePickerLoad()` loads the whole picker tree (local data).

### E3. Units without geometry in phase 1

These are DROM régions and every non-French unit. Because French sources are gated on country (E1), they get:
- a box fit through the box-rim path (`map/composables/useMapCamera.ts:281-304`);
- centre-anchored pins with no hit ring (`useMapPins.ts:139,157`);
- no outline (`useMapFeed.ts:52`);
- no plateau and no hold;
- analyses in the panel only.

**Antimeridian.** A unit row with `wrap: true` is fitted over [0°, 360°). This affects staging world data only.

### E4. The picker and layering

New `features/places` (deps `[]`):
- `gazetteer.ts`: loads `index.json`, `<CC>.search.json` and chunks, with an in-memory LRU. It checks content-type (C4).
- `CountrySelect.vue`.
- `PlacePicker.vue`: "Rechercher" over the search index, then loading the one chunk that holds the hit; "Parcourir" one region chunk at a time. Keyboard and screen-reader friendly, with an ODbL attribution line. A pick emits `{country, unit_id, chunk}`.
- `PlaceField.vue`: `CommuneCombobox` (moved here unchanged) for France, `PlacePicker` elsewhere.

Admin keeps `LocationCombobox` (emitting the BAN feature) for France and uses `PlacePicker` abroad.

`eslint.config.js:100-116`:
- `places: []`;
- `testify: ["places"]`;
- `admin: ["auth","filters","places"]`.

The picker is a lazy chunk.

### E5. Verification method

- **CI.** The parity harness (B7a).
- **In page.** The comparer on local and staging prod-like data: zero diffs except D1 (and D14 while the job has stale rows). It covers lieu labels, embedded lists, every unit's figures, results, frames and testimony lists.
- **Pane walks** (memory: preview-pane-verification). DOM snapshots and a PIL pixel diff across France → région → Rhône → Lyon → Lyon 7e → lieu, in results mode, with analyses on. Taken before and after I, then serveur against corpus at prod size.
- **Lazy path.** `?budget=0` locally: no plateau sink on a filter change, and no scroll jump while paging results.
- **Performance.** `__acPerf` select→plateau must not regress.

---

## F. Seed and load test

### F1. Small profiles (PR F)

- **Committed fixtures.** `scripts/seed/fixtures/fr-units.json` and `fr-places.json`, generated once by `fixtures/build-fixtures.ts` with `frChain` and `placeLieu`, so CI needs no network.
- **Edge places.** Added to `scripts/seed/places.ts`'s edge cluster (`:106-119`, which already holds Ardèche and Saint-Denis): "Serres", "Ribiers" and "France".

  | Seed location | Placement |
  |---|---|
  | Ardèche | `fr:dep:07` (`departement`) |
  | Saint-Denis | `unplaced`, with candidates |
  | Serres | `fr:com:05166` (homonym settled) |
  | Ribiers | `unplaced` (commune déléguée: BAN null) |
  | "France" | `unplaced` (generic) |

- **`generate.ts`.**
  - Writes the place columns and `geo_units`; the TRUNCATE at `:583` gains `geo_units`; the column lists at `:589,603` change.
  - Keeps 5 legacy-shaped French rows with `placed_location` NULL.
  - World rows stay unplaced. **M creates `fixtures/world-units.json`** (517 seed cities); **N switches** the world profile to it.
- **`SEED_SHAPE=legacy`** emits pre-phase-1 rows for CI step 5.
- **Determinism.** Byte-identical output across runs.

### F2. Big profile (PR O): France first

**Writer.** `scripts/seed/big.ts` spools per-table COPY data files under `~/.cache/ac-seed/out/<run>/`:
- `geo_units.copy`, `auditions.copy`, `testimonies.copy`, `submissions.copy`;
- correct COPY escaping and array literals;
- absolute timestamps from `SEED_BASE_DATE`;
- no generated columns in the column lists.

Nothing is joined in memory, which avoids the single join that overflows near 250k rows (`generate.ts:565-656`).

**Loader.** `scripts/seed/load-big.sh <local|staging>` cats one session:
1. `set statement_timeout = 0; set maintenance_work_mem = '512MB';`
2. The guard DO block (`generate.ts:572-580`), then truncate.
3. Drop `testimonies_search_trgm_idx` and `testimonies_audition_facts_idx`.
4. **One COPY per table**, in FK order.
5. Recreate both indexes.
6. Marker, then `vacuum (analyze)`.

The derive trigger stays on: it is the parity path, and COPY becomes row-at-a-time, which is measured. **Never `session_replication_role = replica`**: it would skip the derive trigger and the FKs.

**France.**
- A geo.api dump is fetched once and cached in `~/.cache/ac-seed/`: `/communes?fields=code,nom,population,centre,mairie,departement,region,codeParent&type=commune-actuelle,arrondissement-municipal`.
- Units come from it; communes are weighted by population.

**Shape.**
- 300k testimonies, about 45k auditions, about 20k lieux, over 24 months.
- France 100%, or 85% with `--world` once M exists.
- About 70% online buckets at mairie points, 30% in-person lieux near them.
- 10% address precision, 3% département-level, 1% unplaced, 0.5% legacy-shaped stale rows.
- **Online testimonies have no `pending` row older than 14 days.** Pending rows exist only in the last 14 days, so `submit_online_testimony`'s housekeeping (`B:413-427`) deletes nothing during the test.
- Text: median 600 characters, long tail to 5k; a Zipf vocabulary of about 30k pseudo-words mixed into `texts.ts`' 146 sentences; grid, legacy and empty topics mixed.

**Loading.**
- **Local:** `… | docker exec -i supabase_db_auditions-citoyennes psql -U postgres -v ON_ERROR_STOP=1`.
- **Staging:** from the **laptop**: `docker run --rm -i postgres:17 psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1`. The script refuses a URL containing prod's project ref and keeps the SQL guard. There is no Actions workflow: per-statement latency from US runners and the private repo's 2,000 minutes make it fragile.
- A `big-small` variant (30k rows) serves local checks.
- Load time is recorded in O and P.

**Order.**
1. A–L are deployed to staging: the corpus is off the page, and `/api/testimonies`, `/api/auditions` and `/api/map` are guarded.
2. Staging moves to its own org on Pro.
3. Then the load.

### F3. Load test (PR P)

**Tool.** k6 scripts in `scripts/load/`, run from the laptop with `scripts/load/run.sh`.
- Directly against the Scaleway container with `X-Proxy-Secret` (`server.ts:104-115`).
- **Each virtual user sets its own random `X-Visitor-IP`** (198.18.0.0/15), which the API believes alongside the secret (`visitor.ts:13-17`).
- A short pass goes through the Worker with an Access service token.
- `pg_stat_statements_reset()` before, a snapshot after.
- First, a local run on the big stack with `EXPLAIN (ANALYZE, BUFFERS)` of every RPC.

**CPU.** `scripts/deploy/scaleway.sh` gains an optional `CPU_LIMIT` (mvCPU); today it sends only `memory_limit_bytes` (`:115-122`). The deploy prints the effective `cpu_limit` read back from the Containers API. The report states it next to every p95, and whether S2 and S10 hold at that share.

**Scenarios.**

| # | Scenario | Pass (server p95 from Server-Timing) |
|---|---|---|
| S1 | Cold boot + first visit (root with facts, facets, FR depth 2) | miss < 1.5 s |
| S2 | Drill, Zipf hot keys, 100 rps, many IPs | hit < 150 ms, hit ratio > 95% |
| S3 | Drill, random cold units in batches, 20 rps, many IPs | `place_counts_many` miss < 1 s |
| S4 | Random filter combinations, many IPs | miss < 1.5 s |
| S5 | Search: 200 vocabulary needles of 3–12 characters, plus 1–2 characters | < 2 s for ≥ 3 characters; 1–2 measured for D11 |
| S6 | Deep jumps (région and département scopes not yet loaded) | miss < 1.5 s |
| S7 | List mode, 10 keyset pages + `through=` | < 300 ms per page |
| S8 | Testimony pages on the biggest online buckets | < 300 ms |
| S9 | Invalidation churn: `/api/verify/:token` from staging outbox tokens, and admin writes with a staging test admin (token supplied by the founder as an env var), 1 per 5 s; plus 1 online submission/s under `RATE_LIMITS=relaxed`, distinct emails | 30 s post-invalidation p95 < 1.5 s, no gate 503 |
| S10 | Soak, mixed 30 rps, 1 h | RSS stable < 450 MB; heap, external and family bytes within A19 |
| S11 | `GET /api/auditions/:id` on the three largest buckets | bytes and p95 recorded; target < 1 s |
| S12 | Drill replay as **one IP**: France → région → département → pan through 20 communes | no 429, no 503 |
| S13 | Limiter proof: one IP above the miss limit | 429 with `Retry-After`; no DB call past the limit |

**Measured.**
- p50, p95 and p99 plus error rate per endpoint and per `X-Cache`;
- 57014 and abort counts;
- container RSS, heap, external and CPU;
- DB CPU;
- per-RPC mean, max and buffers from `pg_stat_statements`;
- response sizes;
- relation, TOAST and index sizes;
- seed load time.

**Report.** `docs/load-test-<date>.md`, with an issue and a B8 mitigation for each missed target. Teardown: truncate to the small seed, `vacuum full`, downgrade.

---

## G. PR plan

Full scope and verification are in `pr_plan`.

| PR | Title | Depends on | Size | Prod DB |
|---|---|---|---|---|
| A | API: lift the 1,000-row caps, drop the corpus prewarm, heap cap | — | S (~150 lines) | — |
| B | DB: derived testimony columns by trigger, indexes, CI db:check | — | M (~750) | M1 |
| C | DB: `geo_units`, audition place columns, `submit_online_testimony` place args | — | M (~400) | M2 |
| D | API: write-time placement, re-placement job, `MAP_SOURCE` | C | L (~1,100) | — |
| E | DB: reviewed France backfill | C, D | S (~300) + review | M3 |
| F | Seed: place columns from fixtures, edge places | C, D | S/M (~350 + fixtures) | — |
| G | DB: read RPCs (batched, admin), `service_role` 5 s, CI parity harness | B, C, F | L (~1,400) | M4 |
| H | API: `/api/places` endpoints, cache families, memory budget, DB gate, guards | A, G | L (~1,100) | — |
| I | Web: opaque unit ids, French geometry gated on FR (no visible change) | — | M (~450) | — |
| J | Web: server data source + comparer (dev switch) | H, I | L (~1,500) | — |
| K | Web: server lists | J | M (~800) | — |
| L | Web + API: server source by default, invalidation, admin filters on the server | K | M (~450) | — |
| M | Gazetteer build (world) + PR #110 id fixes + world seed units | PR #110 | M/L (~900) | — |
| N | Places picker, worldwide online form (flagged), admin abroad | D, M | L (~1,100) | — |
| O | Seed: big spooled profile (France first) + laptop loader | F, G, L | M (~700) | — |
| P | Load test + report | L, O | M (~600) + campaign | — |
| Q | Cleanup after the soak | P | S/M (net ≈ −1,600) | drop superseded index |

**Merge order.** A, B, C, D, E, F, G, H, then I (any time), J, K, L, O, P, Q. M and N go in whenever PR #110 merges; P does not wait for them.

**Rules.**
- Rename migration timestamps at merge.
- Each migration reaches staging (and prod) before its callers merge.
- Every API test file goes into `apps/api/package.json:11`.

---

## H. Risks, rejected review points and founder questions

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A trigger bug blocks old-app writes on prod | Exception-safe trigger, `derive_version = -1`, CI writes as `authenticated`, a zero-`-1` check after every push |
| R2 | ICU/ctype differences change `lower()` | The migration asserts `und-x-icu`; parity fixture; record `datctype`/`datlocprovider` in PR B |
| R3 | Storage: `search_text` + trigram is about 2–3× the testimony text; prod Free fills around 60–80k real testimonies instead of ~100k | Measured in P; fallback to an expression index (same results, slower recheck); founder question 2 |
| R4 | Lazy-tree regressions in a watcher-order-sensitive map | Complete subtrees with facts and lists at prod size; chain-then-swap on key change; the comparer; `?budget=0`; pixel diffs; default flips only after a staging soak |
| R5 | `service_role` timeout differs on hosted, or supautils refuses it | M4's guarded `alter role`; hosted `rolconfig` recorded; pg_sleep probe; abort at 7 s + gate slot hold + 503 |
| R6 | 1–2 character needles scan sequentially at 300k | S5; `SEARCH_MIN_CHARS=3` as D11 |
| R7 | Old-app edits leave stale placements until cutover | Harmless (new stack not on prod); sweep dry run at cutover |
| R8 | GERS churn and INSEE yearly changes; `lieu_id` moves on remap | `geo_release`, `wikidata` and points stored; explicit repointing (C7); in-memory tokens only; generation bump |
| R9 | Process-local state skews the load test | MAX_SCALE 1, the bounded LRUs, one memory budget, reported |
| R10 | PR #110 stays open | Only M, N and the world seed slice wait |
| R11 | Admin pages at scale (whole admin list with content; `useTopicAnalysis.ts:78-92` makes N GETs) | Out of scope; excluded from the load test; the admin filter RPC stays O(testimonies) |
| R12 | geo.api.gouv.fr outage during writes | Online already depends on it; admin creates insert stale and the job retries |
| R13 | The BAN host moves to data.geopf.fr | `BAN_BASE_URL` config |
| R14 | The row-at-a-time COPY through the trigger is slow | Indexes dropped during load; measured in O; minutes-scale expected |
| R15 | Dual writers at cutover: old-app writes do not invalidate API caches | 60 s TTLs; the sweep after the switch |
| R16 | The 5 s `service_role` bound cuts a legitimate heavy service-role call | Only API calls use `service_role`; migrations, backups and loaders run as `postgres`; the housekeeping DELETE is now indexed |
| R17 | Gazetteer release skew between web and API | One lock watched by both deploys; `previous` build kept; 409 "Lieu à re-choisir"; HTML treated as skew |

### Review points not adopted

None of the 37 round-2 issues was rejected; each was verified in code (§0.3). Two fixes take a narrower form than proposed:
- **Remap-stable `lieu_id` (issues 1 and 34).** It was not adopted. Any stable hash either collides for same-named explicit picks or diverges from today's identity. The change on remap is documented instead (A3).
- **Issue 37.** It was partly already met: the PR-plan JSON had sizes. The G table now has them too.

### Founder questions

Adopted on 2026-10-26 as recommended, so that work could start; each can still be overridden by the founder. Two remain open because they are needed later: the Supabase organisation for the load test (needed at PR P) and the R2 custom domain (needed before phase 2).

1. Should testimonies of draft (unpublished) auditions stop counting on the public Témoignages page? That covers 'N résultats', search results and the theme picker's counts. Testimonies with no audition at all would also leave the theme counts.
   - **Adopted.** Yes. Count only what the map and the lists can show. Drafts leak into these numbers today only because the whole-corpus download has no status filter. The map, the lieux and the analyses already hide drafts. The admin list keeps seeing every status, as today.
   - Why it matters: These numbers change visibly the day the new page replaces the old one. Every server count, search and aggregate needs one rule fixed up front.
2. Should free-text search keep exactly today's meaning: the typed text found anywhere in the witness's words, ignoring accents and case, even for 1–2 letters? The alternative is word-start matching, which is smaller and faster but finds 'écol' and not 'logie'.
   - **Adopted.** Keep today's meaning. It costs roughly 2–3× the testimony text in storage, so the production database outgrows the free plan at about 60–80k testimonies instead of ~100k. If the load test shows 1–2 letter searches are too slow at 300k, add a 3-letter minimum with a hint. Word-start search can come later as a second mode.
   - Why it matters: It decides the index type and storage, and when production must leave Supabase Free. Changing the meaning changes which testimonies people find.
3. The 300k-testimony load test needs Supabase Pro ($25/month plus compute). Plans are per organisation, and staging shares production's. Should staging first move to an organisation of its own?
   - **Open (needed later).** Yes. Move the staging project to a new free organisation and upgrade only that one to Pro for the campaign month. Then reseed small and downgrade. Production's plan and bill stay untouched. You also run the big-seed loader from your laptop, and provide a staging test-admin token for the write scenario.
   - Why it matters: Upgrading the shared organisation would bill and change production as well. It is the one unavoidable cost of phase 1.
4. Should people outside France be able to send an online testimony in phase 1? If so, with what wording? For example 'Audition en ligne de mai — Berlin (Allemagne)' and, in the email, 'rattachés à Berlin (Allemagne)' instead of 'de la Mairie de …'.
   - **Adopted.** Build it now, grouped by town or city and month (Paris time), on for staging only. Keep it off in production until you approve the wording and phase 2 draws world boundaries. Until then a foreign city shows as a framed area with pins and no raised plateau.
   - Why it matters: It sets the online audition bucket outside France, the public labels and emails, and whether non-French places reach production before their outlines exist.
5. Should Guadeloupe, Martinique, Guyane, La Réunion, Mayotte and the overseas collectivities count under France, as régions and départements, or as countries of their own?
   - **Adopted.** Under France, following the official INSEE/Etalab divisions, as the map shows them today. Overture's separate overseas outlines are only drawn, and light up as France.
   - Why it matters: It changes France's totals, the first step of the place picker, and which map shape lights up for a Guadeloupe testimony.
6. Outside France, how fine should the place list go? And where should an admin place an audition held abroad?
   - **Adopted.** Offer every place with an official boundary, plus towns of 1,000+ inhabitants or classed city/town, and leave villages and hamlets out. The boundary places alone weigh about 27 MB compressed across ~630 files, plus a small search file per country. Place an admin audition abroad at its town's point, with the lieu's name as free text. Street addresses abroad wait for a later geocoder.
   - Why it matters: It sets the size of the files the site hosts and downloads per search. It also decides whether some picked places have no outline to light up in phase 2.
7. In the one-time move of production's existing places, should today's grouping of lieux be kept exactly? Examples: 'Place Ferber, Bron' filed under the Bron médiathèque, 'Place Jean Macé' under 'Marché Jean Macé', and 'Quai Augagneur' and 'Quai Victor Augagneur' as two lieux.
   - **Adopted.** Yes, keep them exactly so the map does not change. You approve the generated review table (about 25 lieux) before the migration ships. Fix oddities afterwards through admin edits. An address picked from the list now places the audition at that address (question 11), and a change to the built-in place rules regroups lieux automatically after the next deploy.
   - Why it matters: The move freezes lieu identities that were recomputed on every read until now. Any fix during the move would be a visible change on the map.
8. Should the two public endpoints that return a whole table at once (/api/testimonies, every testimony; /api/auditions, every audition) remain once the map no longer uses them?
   - **Adopted.** Keep them, deprecated and no longer prewarmed. Each refuses (asks callers to use the place lists) above 25,000 testimonies or 5,000 auditions, far above production today. Remove them at cutover unless you know of a third party using them.
   - Why it matters: At scale neither can be served by the 512 MB container: the audition list takes tens of seconds at 45k auditions. Removing a public endpoint is a contract change if anyone relies on it.
9. In Paris, Lyon and Marseille, should online testimonies keep being grouped by town hall (Paris 1er–4e under Paris Centre, Marseille by sector), without recording the witness's own arrondissement?
   - **Adopted.** Yes. Keep the town-hall grouping exactly as today, and do not store the witness's arrondissement.
   - Why it matters: Storing the arrondissement would be new personal data, and would change how those testimonies are counted on the map.
10. In phase 1 the place lists are served free from the site's existing Cloudflare hosting. Phase 2's boundary tiles need Cloudflare R2, which requires a custom domain. Which domain should it use?
   - **Open (needed later).** Use the static hosting now. Pick a subdomain such as tiles.<site domain> and add it to Cloudflare before phase 2 starts.
   - Why it matters: The domain is needed before the phase-2 tiles and the gazetteer can move to R2's free egress. Only you can set it up.
11. When an admin picks an address from the suggestion list, should the audition be placed exactly there, even if another audition with the same lieu name is placed somewhere else? Today the typed text is re-located and same-named lieux always merge into one.
   - **Adopted.** Yes, the explicit pick wins. It lets an admin correct a misplaced lieu by re-picking it. Same-named lieux typed without a pick still merge as today. Production's existing auditions are unaffected: the backfill uses no picks.
   - Why it matters: It decides whether two auditions with the same lieu name can appear as two places on the map, and whether admins can fix a wrong placement themselves.
