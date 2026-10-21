# Architecture proposal — 2026-10-20

Scope: `apps/web/src` (27.9k lines), `apps/api/src` (4.4k), `packages/shared/src` (1k). Method: seven mappers read every oversized file and cluster and listed its responsibilities with line ranges; one architect merged them into a target layout; one critic checked the layout against the real imports (cycles, line counts, lint, behaviour). The critic's verdict was "sound with fixes"; the fixes are applied below. Line numbers refer to the working tree on 2026-10-20 (your WIP included).

## Diagnosis

**Three things are wrong, and they are structural, not cosmetic.**

1. **Files are split by technical kind, not by feature.** `components/` (33 files, flat), `composables/`, `lib/`, `pages/`. To find "the admin audition list" you open four folders. To find "what the map does" you open one 7,131-line file.
2. **The two giants are not components.** `GeoDrillMap.vue` has an 8-line template and a 7,097-line script: two WebGL custom-layer classes (2,200 and 270 lines, shaders inline), a per-frame "frame bus", projection caches, hit testing, camera logic, the DEM plateau pipeline, pin management. `GeoNav.vue` (3,443 lines) is the whole Témoignages experience minus WebGL: five kinds of boundary fetches, the geo hierarchy, scope derivation with hysteresis, the side panel, the phone bottom sheet, the analyses ring, camera commands, keyboard focus, screen-reader text. Both grew because every function closes over the same `let map` and the same plain-`let` flags.
3. **Dependencies point the wrong way in several places.** `lib/filters.ts` imports a type from a `.vue` component. `ScopeAnalysisOverlay.vue` imports a type from `GeoDrillMap.vue` (so a type pulls in Mapbox). Route names are string literals in four files. The dialog pile and the `LocNode` type live in second `<script>` blocks because `<script setup>` cannot export.

Smaller but real: `lib/geo.ts` is six modules in one file; `Landing.vue` is four sections sharing one scoped stylesheet; `AuditionAdminList.vue` is four composables and an edit dialog in one `<script setup>`; the API's `routes/auditions.ts` and `routes/testimonies.ts` do parse, role check, query, sanitize, invalidate, geocode, audit and email inline; `packages/shared/domain.ts` mixes DB aliases, response shapes, admin contracts, AI constants and the Lyon location rules dataset.

## Target layout

### Rules

1. One folder per feature under `features/`, each with an `index.ts` barrel. Other code imports a feature only through its barrel; inside a feature, relative imports.
2. Features form a one-way layering: `geo → map → analyses → geo-nav → temoignages → map-stage → app`. `filters`, `auth`, `testify`, `home`, `audition`, `admin` sit beside them. A lower layer never imports a higher one. Enforced by ESLint (`no-restricted-imports`, later `eslint-plugin-boundaries`).
3. `shared/` holds only feature-agnostic code (design system, API client, date formatting, DOM measurement, the testimony renderers) and imports nothing outside `shared/` and `@ac/shared`. `app/` holds what exists once per app (shell, router, header, global dialogs, query defaults); nothing imports `app/` except `main.ts`.
4. A file does one thing and stays between 150 and 500 lines, unless it is a GL layer class or a template-heavy SFC. Split by responsibility, never by line count.
5. Hot-path state stays non-reactive: Mapbox instances, GL layers, typed arrays, frame buffers, the overlay's slab records are plain `let`s owned by one composable and exposed through getter functions. Nothing wraps them in `ref`/`reactive`.
6. Module-level singletons (map stage slots, dialog pile, toasts, theme, the two global popups, API caches, geocode throttle) keep exactly one home and one import path.
7. Every step is a mechanical move plus import rewrites with zero behaviour change: watcher order, layer install order, Fastify route order, CSS cascade order, DOM selectors, event names, localStorage and vue-query keys preserved verbatim; cross-file string contracts become exported constants.

### apps/web/src

```
main.ts                      boot only (25)
App.vue                      shell template (60 ← 135)
app/                         once per app; imported only by main.ts
  AppDialogs.vue             the two lazy site-wide popups (90)   useLazyDialog.ts (40)   query.ts (20)
  NotFoundPage.vue           (renamed: the multi-word lint rule only exempts pages/)
  router/index.ts (15)  router/routes.ts (60)
  header/AppHeader.vue (330 ← 594)  HeaderMobileMenu.vue (120)  useHeaderTuck.ts (55)
shared/                      feature-agnostic; imports only shared/ and @ac/shared
  routes.ts                  ROUTE name constants + RouteMeta.bleed (features read this, never app/)
  api/client.ts (60)  api/supabase.ts (31)
  dom/header.ts              HEADER_SELECTOR, headerBottomPx, isPhone (30)
  format/dates.ts (31)
  testimony/TestimonyCard.vue  TestimonyText.vue  HighlightText.vue  text.ts
  ui/dialog/ModalDialog.vue + dialogPile.ts (the pile leaves the second <script> block)
  ui/transition/ExpandTransition.vue  ui/feedback/LoadingDots.vue
  ui/toast/useToast.ts + ToastHost.vue  ui/theme/useTheme.ts  ui/directives/autogrow.ts
  ui/select/treeNode.ts (LocNode as .ts)  LocationMultiSelect.vue  LocationTreeNode.vue  ThemeMultiSelect.vue
  styles/index.css           @imports in today's cascade order; the one import in main.ts
  styles/tokens.css  base.css  utilities.css  forms.css  buttons.css  chips.css  feedback.css   ← global.css
features/
  geo/                       pure geo model, no Vue, no Mapbox            ← lib/geo.ts 528
    types.ts  bounds.ts  hierarchy.ts  boundaries.ts  scope.ts  labels.ts
  map/                       the Mapbox engine                              ← GeoDrillMap.vue 7131, slabs.ts, mapSnapshot.ts
    GeoDrillMap.vue          thin shell: props/emits, map creation, wiring, watchers in today's order (380)
    types.ts                 MapUnit, CameraCmd, OutlineFC, PlateauFrame, SlabFrame, SlabSpec … (200)
    events.ts                MAP_MOVED_EVENT
    geo-pins.css
    lib/                     pure; exported as its own entry '@/features/map/lib' so analyses never pulls the component
      polygon.ts (330)  projection.ts (440)
      slabs/constants.ts  slabCamera.ts  fitSilhouette.ts  slabScales.ts  slabRects.ts  homography.ts   ← slabs.ts 1078
    gl/
      program.ts (130)  mesh.ts (230)  plateauShaders.ts (320, the GLSL as named constants)
      PlateauWallLayer.ts (~1,900: the documented exemption; SlabPieces extraction is a later option)
      ScopeTintLayer.ts (300)
    plateau/mapSnapshot.ts (227)
    composables/
      useScopeMask.ts (360)  useMapView.ts (210)  useMapCamera.ts (720)  useMapPins.ts (620)
      usePlateau.ts (450)  usePlateauLid.ts (240)  usePlateauFrames.ts (330)  useSlabOcclusion.ts (240)  usePlateauSlabs.ts (340)
    dev/probes.ts (110)
  analyses/                  what the association heard → words on the lids   ← ScopeAnalysisOverlay.vue, analysisPlates.ts, scopeStats.ts, slabDev.ts
    stats/scopeStats.ts (323)
    content/text.ts  themeColors.ts  ring.ts  measure.ts  slabSizes.ts  plateRoom.ts (keeps edgeMargin, slabGap, NEAR_GROWTH, FRAME_MIN_*)  summary.ts
    devSwitch.ts (115)
    composables/useScopeAnalysis.ts (220 ← GeoNav)   explicit inputs; returns { scopeAnalysis, analysesVisible, slabSizesNow, slabSpec, roomNow }
    overlay/ScopeAnalysisOverlay.vue (~800: template + CSS + swapContent + probe stay here)
    overlay/useRingPick.ts (200)  useSlabLayout.ts (420)  DevSlabSwitch.vue (200)  frameSource.ts (15)
  geo-nav/                   the Témoignages experience minus WebGL           ← GeoNav.vue 3443
    GeoNav.vue               orchestrator: navState, composables in dependency order, cross-cutting watches (420)
    navState.ts              one per-instance record + {value} boxes incl. roomNow (70)
    data/useBoundaryQueries.ts  useCommuneGeo.ts  useDepFine.ts  useImportedAuditionText.ts
    model/useGeoHierarchy.ts  useScope.ts  useMapFeed.ts  auditions.ts  usePanelAuditions.ts  useCamera.ts  useNavActions.ts
    panel/GeoPanel.vue  Breadcrumb.vue  UnitList.vue  AuditionList.vue  usePanelLayout.ts  useBottomSheet.ts  useViewport.ts
    ring/useAnalysesRing.ts (260)  usePlaqueFocus.ts (60)
  temoignages/               the explorer the stage shows                     ← pages/Temoignages.vue 408
    TemoignagesExplorer.vue (250)  api/queries.ts (65)  useTestimonyFiltering.ts (115)  useAnalysesToggle.ts (45)
  map-stage/                 the one Mapbox instance above the pages
    MapStage.vue (250)  StagePage.vue (30 ← pages/TemoignagesPage.vue; moved here to break the stage ↔ temoignages cycle)
    useMapStage.ts (41)  useCardOpenGestures.ts (90, returns { reset, isModifierHeld })  openTransition.ts (45)
  filters/                   shared by temoignages and admin
    useFilters.ts  match.ts  options.ts  FiltersDialog.vue  FilterChips.vue
  home/                      ← pages/Landing.vue 964
    HomePage.vue (200)  home.css (170, the classes several sections share)  HeroSection.vue  ProjectSection.vue  TestimoniesSection.vue  AuditionsSection.vue
    useMapCardSlot.ts (80)  content.ts  vReveal.ts  homeImages.ts
  auth/
    store.ts (66)  api.ts  lib/password.ts  authErrors.ts  reauth.ts  passwordRecovery.ts (reader only; the listener stays eager in shared/api/supabase.ts)
    composables/useIdleTimeout.ts  components/OAuthButtons.vue  UsernamePromptDialog.vue  PasswordRequirements.vue  AuthCard.vue
    pages/AuthPage.vue (430 ← 511)  ResetPasswordPage.vue (200 ← 293)
  testify/                   the visitor's own testimony
    api.ts  geopf.ts  useSubmitTestimony.ts  SubmitTestimonyDialog.vue  CommuneCombobox.vue  pages/VerifyTestimonyPage.vue (540)
  audition/pages/AuditionDetailPage.vue (247)
  admin/                     one feature, per-resource subfolders
    admin.css (.admin-card only; .chip stays in shared/styles because /verifier uses it)
    pages/AdminPage.vue (290)  shell/PendingApprovalCard.vue
    account/AccountSection.vue (350 ← 463)  usePasswordChange.ts (120)  api.ts
    registrations/api.ts  usePendingRegistrations.ts  PendingRegistrations.vue  RoleManagement.vue
    audit-log/api.ts  auditEntry.ts (165)  AuditLogTable.vue (220 ← 385)  AuditionPreviewDialog.vue
    auditions/api.ts  useAdminAuditions.ts  useAuditionFilters.ts (135)  useAuditionPopup.ts  useTopicAnalysis.ts
              AuditionAdminList.vue (450 ← 938)  AuditionEditDialog.vue (150)  CreateAuditionDialog.vue (534)  useCreateAudition.ts  LocationCombobox.vue
    testimonies/api.ts  TestimonyManager.vue (431)  TestimonyEditDialog.vue (188)
```

After the plan the only modules over 800 lines are `gl/PlateauWallLayer.ts` (~1,900, a GL class; a `SlabPieces` collaborator can take ~700 of it later) and `ScopeAnalysisOverlay.vue` at the ceiling (template plus scoped CSS).

### apps/api/src

```
index.ts  server.ts  config.ts (+ CACHE_DIR)
lib/                         cross-cutting; never imports modules/
  supabase.ts  auth.ts  cache.ts (generic TTL + single-flight)  publicCache.ts (the three keys + generation + invalidate)
  rateLimit.ts  audit.ts  dates.ts (frDate)  email/resend.ts  email/verification.ts  email/registration.ts
modules/                     one folder per resource: routes.ts (HTTP) + service.ts (rules against a passed client)
  health/  account/ (← me.ts)  admin/
  auditions/routes.ts (150 ← 374)  service.ts (280: published list, admin list, create/update/delete, placeKeyOf, onlinePlaceOf, auditionGone)
  testimonies/routes.ts (130 ← 422)  service.ts (320)  analysis.ts (120)
  verification/routes.ts (90 ← verify.ts 227)  service.ts (150)
  online-testimonies/routes.ts (110)  service.ts (120)  townHall.ts (← places.ts)
  map/routes.ts (← map.ts)  locationGroups.ts (← locations.ts 55-158)      imports auditions/service and geo/geocode
  geo/geocode.ts (313)                                                         no module imports: leaf
  imported-auditions/routes.ts  service.ts  frDepartments.ts
  boundaries/routes.ts  geometry.ts (330, pure)  service.ts (260, fetch + caches)
  dem/routes.ts  service.ts (235)  png.ts (45)
```

Dependency graph: `map → auditions → geo`, `map → geo`, `imported-auditions → geo`, `online-testimonies → geo`. Acyclic. Services take `(client, log, actorId, input)` and throw typed errors the route maps to status codes, the convention `logAudit` and `auditionGone` already follow.

### packages/shared/src

`index.ts` keeps exporting every name, so no consumer changes. `domain.ts` splits into `db.ts` (row aliases), `auditions.ts`, `testimonies.ts`, `admin.ts`, `locations.ts` (normalisation, `LOCATION_RULES`, generic buckets); `themes.ts` absorbs `AUDITION_THEMES`; the three dead schemas (`analyzeTestimonySchema`, `verifyTestimonySchema`, `registrationActionSchema`) go in a separate cleanup commit.

## Migration order

Each step is one PR that lands alone with typecheck, lint and format green and the site behaving the same. `git diff -M` should show renames.

| # | Step | Size | Why this order |
|---|---|---|---|
| 0 | Commit the WIP on `dev` | — | ~60 modified and 32 untracked files; moving them first turns renames into delete+add and leaves nothing to bisect against. Stop the :5173 server first. |
| 1 | `packages/shared`: split `domain.ts` behind the unchanged barrel | S | Zero consumer change. Dead schemas deleted in a separate commit. |
| 2 | API `lib/`: move infrastructure out of the top level and `services/`; `config.CACHE_DIR` | S | Leaf modules. Keep the `declare module 'fastify'` augmentation as a value import from `server.ts`. |
| 3 | API `modules/`: one folder per resource, moved as-is; the two pure/stateful splits (boundaries geometry, dem png); caches pointed at `CACHE_DIR` | S | HIGH risk only if a cache path is missed: an empty geocode cache empties the map until the warm pass; an empty boundaries cache re-downloads 11.7 MB. Check mtime and size after a boot. |
| 4 | API routes → services, one resource per PR (auditions, testimonies, verification, online-testimonies) | M | The only API step that is more than a move. This is also where the optimisation audit's PR 1 to 3 should land, since those handlers are being re-read anyway. |
| 5 | Web `shared/`: design system, testimony renderers, API client, dates, styles split; boundary lint as a warning | M | Codemod the imports in one PR (`useToast` 16 importers, `api` 16, `format` 10, `ModalDialog` 9). `styles/index.css` @imports in today's order. |
| 6 | Web `app/`: router with `ROUTE` constants in `shared/routes.ts`, `query.ts`, `AppDialogs` + `useLazyDialog`, header split, `NotFoundPage` | S | Keep `defineAsyncComponent` loaders by path; `header.header` / `.header-inner` are measured by MapStage and GeoNav. |
| 7 | Web leaf features moved as-is: auth, testify, audition, filters, home, admin | M | Pure `git mv` + barrels; `lib/filters.ts` moves whole and splits in step 8. The PASSWORD_RECOVERY listener stays eager in `shared/api/supabase.ts`. |
| 8 | Internal splits in home, admin, auth | M | Landing → four sections + `home.css`; AuditionAdminList → four composables + edit dialog; HeroSection must emit `ready` on the synchronous `img.complete` path too. |
| 9 | Web geo + map-stage + temoignages; GeoNav, GeoDrillMap and the overlay moved as-is with the type block extracted | M | `lib/geo.ts` → six pure modules; the giants untouched inside their folders. |
| 10 | Split the pure libs: `slabs.ts`, `analysisPlates.ts`, `slabDev` | S | `constants.ts` leaf makes the graph acyclic; localStorage keys unchanged. |
| 11 | Overlay split + `useScopeAnalysis` lifted out of GeoNav | M | Slab records stay plain lets; `swapContent` and the probe stay in the SFC. |
| 12 | GeoNav split, three PRs: (a) data + model, (b) panel/sheet/camera/ring, (c) panel components | L | `navState` created first resolves today's lazy forward references; `setCamera ↔ ring` handled by a `beforeCommand` hook and a late-bound `roomNow` box. |
| 13 | GeoDrillMap split, three PRs: (a) `gl/` + pure libs, (b) low-coupling composables, (c) camera, pins, plateau, slabs | L | Last, because everything depends on its types. Every composable takes a `getMap` getter and explicit callbacks; `PlateauWallLayer` gets `setPaused()` instead of reading the component's `offscreen`. Verify with the manual frame pump in the preview pane. |
| 14 | Boundary lint to error, delete the empty legacy folders, short README map | S | Optional `eslint-plugin-boundaries` encoding the layering order. |

Rough effort: steps 1 to 4 are a few days (4k lines, mostly moves). Steps 5 to 8 a week. Steps 9 to 13 two to three weeks of careful, mechanical work, with the preview pane open at every PR because there are no web tests.

## Deliberately not doing

- No Pinia store or provide/inject for the geo-nav state: the home card and the page are the same GeoNav instance under MapStage, and the state must die with it. `navState` is a plain per-instance record.
- No reactive wrappers around the map, the GL layers, the snapshot manager, typed arrays or frame buffers.
- No renames of `ThemeMultiSelect` / `LocationMultiSelect` (generic code, French wording baked in): moved under `shared/ui/select` with today's names.
- No merge of `LocationCombobox` (BAN, admin) and `CommuneCombobox` (IGN, public form): look-alike skeletons, different APIs and models.
- No dead-code deletion inside move commits (`childrenBounds`, `levelKeyForZoom`, `LEVEL_LABEL`, …): separate cleanup commits keep every reorg diff a pure rename.
- No per-feature lazy CSS: `admin.css` and `geo-pins.css` stay globally imported so the cascade and first paint are identical; the folder only says who owns the rules.
- No web tests, no extra path aliases (`@/` stays the single alias; the lint rule matches `@/features/<x>/…` deep paths directly).
- Not now: the `SlabPieces` extraction out of `PlateauWallLayer`, unifying the two button systems, de-duplicating the verification email template. Each changes rendered output.
