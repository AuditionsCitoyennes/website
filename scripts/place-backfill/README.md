# scripts/place-backfill

Generates the reviewed backfill of a database's places (map phase 1, design §B4,
PR E): one migration that files every audition already in production under its
lieu, as the API files a new one, after a person has read where each lieu lands.

`generate.ts` reads the target's auditions with its **publishable key** (what any
visitor may read: every offline audition, drafts included, and the online ones
with a verified testimony), places them with the API's own code — text only, no
admin pick, no reuse of stored rows — and writes four files:

| File | What |
|---|---|
| `supabase/migrations/<version>_backfill_places_fr.sql` | The migration: `geo_units` inserts (`on conflict do nothing`), then a `DO` block of keyed `UPDATE`s of the rows never placed (offline by raw location; online by town hall code, at their own point, or on no point without one) and NOTICEs of what this run placed. |
| `supabase/tests/backfill_places_fr.sql` | Its fixture test: listed rows placed as listed, online rows at their own point under their own label (on no point without one), a row changed since the review, an offline row carrying a listed code, an online row labelled like a listed spelling and an online point out of range left stale, a row already placed left alone, a second run changes nothing. Run by `npm run db:check` (check `backfill`). |
| `supabase/tests/backfill_places_fr.expected.json` | Raw location (offline) or town hall code (online) → unit chain. Read by `db:check` and by `db:check:seeded` (B7 step 5). |
| `docs/backfill-places-<date>.md` | The review table, for the founder's sign-off. |

How it places:

- **Offline rows**: one placement per lieu key (`getCanonicalLocation`), for
  every raw spelling of it, by `placeLieu` (apps/api/src/modules/places). The
  `UPDATE` matches them by their exact raw `location`.
- **Same-named communes** are settled at the end, against the plan's own
  published offline lieux placed without homonyms (what `placement_support()`
  counts on stored rows). Unsettled ones are written on no point, with their
  candidates, for the placement job.
- **Online rows**, per town hall code: its units from geo.api, precision
  `address` (or `commune` where geo.api has no town hall), no rules hash; each
  row at the point it stored (`place.lat`/`place.lng`), on no point without
  one — as the placement job files them (`placeOnline`). The `UPDATE`s match
  them by `citycode`; each row keeps its own label as lieu key. A stored point
  out of range is left alone (stale), as the API could not store it either.
- **Generic texts, unknown names**: written on no point (`place_precision =
  'unplaced'`), so that after the push only rows written later are stale.
- Offline rows are stamped with the `LOCATION_RULES` hash (`placed_rules`); a
  later rules change reaches them through the job's rules pass.

On the seeded local stack, the backfill wrote exactly what the placement job
writes for every row of the town halls and spellings it lists (place columns
and `geo_units`, compared column by column), and nothing else.

## Running it against production

You need: the project's URL and its publishable key (Dashboard → Project Settings
→ API keys, or the web app's `VITE_SUPABASE_PUBLISHABLE_KEY`); `npm ci`; optionally the
Etalab contours for the cross-check, in `~/.cache/ac-map-data/raw` (built by
`scripts/map-data`, or just the three files):

```bash
mkdir -p ~/.cache/ac-map-data/raw && cd ~/.cache/ac-map-data/raw
for f in communes-50m departements-50m regions-50m; do
  curl -fsSL "https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2026/geojson/$f.geojson.gz" \
    | gunzip > "etalab-$f.geojson"
done
```

The command reads nothing from any `.env`, and refuses a secret or service-role
key: it needs none, and must see only what the public sees.

1. **Generate, outside the repository** (a dry run: nothing is written to any
   database, ever; BAN and geo.api.gouv.fr are asked one request at a time):

   ```bash
   export PLACE_BACKFILL_URL=https://nnnhefcdanzxsgnaletc.supabase.co
   export PLACE_BACKFILL_KEY=sb_publishable_…
   npm run place-backfill -- --out "$TMPDIR/backfill" --http-cache "$TMPDIR/backfill-http.json"
   ```

   It stops before writing anything if BAN or geo.api keep not answering (a
   curated lieu's reverse geocode included), if BAN answers like a wrong address
   (a 404 or 410: check `--ban`), if it does not find Lyon in 69123 before it
   starts, if most offline lieux land on no point (`--force` to write them all
   the same, after a look), or if the auditions change while it reads them. A
   BAN 404 is never kept in `--http-cache`.

2. **Review** `$TMPDIR/backfill/docs/backfill-places-<date>.md` with the founder:
   every lieu's units and point, and the "To look at" sections — keyword-rule
   collapses, lieux within 50 m of each other, same-named communes, lieux on no
   point, town halls whose months disagree, Etalab warnings. A wrong lieu is
   fixed at its source (`LOCATION_RULES`, the audition's text through the admin,
   or later by an admin pick), then generated again — never by editing the SQL.

3. **Commit exactly what was reviewed**: copy the four files into the
   repository, on a branch from `dev`:

   ```bash
   cp -R "$TMPDIR/backfill/." .
   git add supabase/migrations/*_backfill_places_fr.sql supabase/tests/backfill_places_fr.* docs/backfill-places-*.md
   git commit -s -m "feat(db): the reviewed backfill of production's places"
   ```

   CI runs the fixture test (`db:check`) and step 5 (`db:check:seeded`: the
   seed shares production's Lyon spellings, so some seeded rows are placed as
   listed, every other one stays stale, a second run changes nothing). Locally,
   on a scratch stack (see scripts/db-checks), `BACKFILL_ROOT=$TMPDIR/backfill
   npm run db:check -- backfill` runs it before anything is copied.

   If another migration merges first with a later version, give this one a later
   version before merging: rename the file and replace the old version in the
   expected list, the test's two `\ir` lines and the review table
   (`sed -i '' s/<old>/<new>/g`). `supabase db push` takes no version older than
   the last one applied.

4. **Push, staging first** (from workdirs linked to each project; dry run first,
   it must list only this file):

   ```bash
   supabase db push --workdir <staging dir> --dry-run
   supabase db push --workdir <staging dir>
   ```

   It places only rows never placed (`placed_location is null`): offline ones
   whose raw location equals a reviewed spelling, online ones whose town hall
   code is reviewed. Read its NOTICEs: `placed now` counts the rows this push
   wrote; `already placed … left as they were` the listed rows the placement
   job (or an earlier run) got to first, which the `UPDATE`s skip; `still
   stale` the rows left to the job. On staging, where the job runs, expect
   most listed rows under `already placed`. Then production, the same two
   commands with its workdir (there, `placed now` should be about every row
   the review lists).

5. **Probe production with the publishable key** (counts and places only):

   ```bash
   curl -s "$PLACE_BACKFILL_URL/rest/v1/auditions?select=location,place_unit,place_precision,place_stale&status=eq.published&audition_en_ligne=is.false" \
     -H "apikey: $PLACE_BACKFILL_KEY"
   ```

   Every published offline lieu should be under the reviewed units, and
   `place_stale` true only on rows the old app wrote or moved after the read
   (the placement job or the cutover sweep places those).

Not covered by design: online auditions with no verified testimony yet are
invisible to the publishable key — those of a listed town hall are placed all
the same (matched by code), the others wait for the placement job or the sweep.

## Options

```text
--out <dir>          where the four files go, in the repository's layout
--migration <file>   one file's path instead (also --test, --expected, --review)
--version <v>        the migration's version, YYYYMMDDHHMMSS (default: now, UTC)
--ban <url>          the BAN to ask (default https://api-adresse.data.gouv.fr)
--etalab <dir>       the Etalab contours (default ~/.cache/ac-map-data/raw; skipped when missing)
--http-cache <file>  keep the geocoder's and the commune API's answers, for the next runs
--force              write the files even when most offline lieux land on no point
```

`supabase/tests/` holds psql scripts for `db:check`, not pgTAP tests: do not run
`supabase test db` on it.
