# Build flags

## What a build flag is here

A build flag is a Vite `define` (apps/web/vite.config.ts): a name the build
replaces by a constant, `true` or `false`, before the bundler sees the code.
Code behind `if (__FLAG__)`, `__FLAG__ ? … : null` or a `v-if` on a
`const x = !!__FLAG__` is then dead in a build where the flag is false, and the
minifier drops it — with every module only it imports. A build without the flag
carries none of that code: nothing to download, nothing to find in the bundle,
nothing to switch on from the browser.

A runtime switch (a `localStorage` key, a query parameter) would ship the code
to every visitor, and anyone could find it and flip it. That is fine for the
testing tools' DEV switches, not for a feature that is not released yet.

The other define of the same kind is `__TEST_TOOLS__` (the outbox, the DEV
switches, the probes): on with `vite` dev and in a build with
`VITE_APP_ENV=staging`.

## `VITE_ANALYSES`

`__ANALYSES__` is true with `npm run dev` (`vite` serve) and in a build whose
environment has `VITE_ANALYSES=on`. It is false in any other build. The first
release ships without the Analyses; staging keeps them while they mature.

A build without it:

- has no « Analyses » button in the panel header;
- ignores `?analyses=1` (it stays in the address, unused);
- sends `/analyses` and `/analyse` to `/temoignages` with their other query
  parameters and no `analyses`;
- analyses, measures and draws nothing (no plates, ring or slabs around the
  plateau, no `document.fonts` listener, an empty `.analyses-live`);
- lists two points, not three, in the home page's « Les témoignages » band
  (« Analysés dans leur ensemble… » is the analyses' one);
- lists three costs on « Soutenir » (« Les analyses » is not one of them);
- drops « , à le compter dans les analyses d'un territoire » from the
  « Règles de publication ».

What stays in that build, small and inert: `features/analyses/devSwitch.ts`
(every unit fit reads `frameFill`), the framing constants of
`content/plateRoom.ts`, `noScopeAnalysis`, `geo-nav/ring/useAnalysesRing.ts`
(it also computes the map's view padding) and `usePlaqueFocus.ts`. The API
still sends every unit's figures with the tree.

Where it is set:

- staging and every PR preview: `.github/workflows/deploy-staging-web.yml`,
  step « Build », `VITE_ANALYSES: "on"`;
- production: nowhere. Leave it unset.

Build each shape locally, from `apps/web`:

```sh
# production-like: no testing tools, no Analyses
env -u VITE_APP_ENV -u VITE_ANALYSES npx vite build --outDir /some/dist-prod --emptyOutDir
# staging-like: both
VITE_APP_ENV=staging VITE_ANALYSES=on npx vite build --outDir /some/dist-stg --emptyOutDir
```

A process variable beats the `.env` file, so check that your `apps/web/.env`
does not set either one when you mean "unset".

## How to verify a build

The overlay is its own chunk, `ScopeAnalysisOverlay-*.js` (with its `.css`):
it exists only in an `on` build.

```sh
D=apps/web/dist
ls $D/assets | grep -c ScopeAnalysisOverlay             # off: 0   on: 2
grep -aoE 'aria-label":`Analyses`|analyses-layer|plaque-title|pouls de chaque localit|dans les analyses' \
  -r $D --include='*.js' --include=index.html | wc -l   # off: 0   on: > 0
```

`analyses-btn` and `analyses-label` still appear in the CSS of an off build
(scoped selectors, not text), and « Analyses manquantes » is the admin's topic
analysis, another feature.

## Removing the flag at the next release

Either set `VITE_ANALYSES=on` in the production build's environment (nothing
else changes), or delete the flag:

1. remove `__ANALYSES__` from vite.config.ts and env.d.ts (and
   `VITE_ANALYSES` from env.d.ts, `.env.example` and the staging workflow);
2. in the files that read it — `geo-nav/GeoNav.vue`,
   `temoignages/useAnalysesToggle.ts`, `temoignages/TemoignagesExplorer.vue`,
   `app/router/routes.ts`, `support/content.ts` (and its test),
   `legal/pages/RulesPage.vue`, `home/TestimoniesSection.vue` — keep the "on"
   branch;
3. decide in that PR whether the overlay stays a lazy chunk
   (`loadScopeAnalysisOverlay`) or goes back to a static import, and whether
   `noScopeAnalysis` goes.

Before turning them on for the public, re-read the « Règles de publication »:
testimonies published without the analyses' clause may need it back, with a
notice of the change.
