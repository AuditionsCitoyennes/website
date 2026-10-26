// The review table of a backfill (docs/backfill-places-<date>.md): what the
// migration writes on each lieu, and what a person should look at before it
// is pushed — keyword-rule collapses, lieux within 50 m of each other,
// same-named communes, lieux on no point, the Etalab cross-check.

import type { PlaceCandidate } from "@ac/shared";
import { distanceKm } from "../../apps/api/src/modules/places/placeLieu";
import type { ContourCheck } from "./etalab";
import { curatedPoint, ruleCollapses, type LieuClass, type Plan, type PlannedLieu } from "./plan";
import type { Backfill } from "./sql";

/** Two lieux closer than this may be one place typed two ways. */
export const NEAR_METRES = 50;

export interface ReviewInput {
  plan: Plan;
  backfill: Backfill;
  /** Repository paths, as the document names them. */
  migrationPath: string;
  reviewPath: string;
  ban: string;
  /** Rows read, offline and online. */
  rows: number;
  nullCreatedAt: number;
  nullStatus: number;
  published: number;
  drafts: number;
  /** Testimonies with no audition: their count, or why it could not be read. */
  orphans: number | string;
  /** The Etalab cross-check, per lieu (by index in plan.lieux); a string: why it did not run. */
  contours: Map<number, ContourCheck> | string;
}

export interface NearPair {
  a: number;
  b: number;
  metres: number;
}

/** Pairs of placed lieux (indexes in plan.lieux) closer than NEAR_METRES. */
export function nearDuplicates(plan: Plan, metres = NEAR_METRES): NearPair[] {
  const placed = plan.lieux
    .map((l, i) => ({ i, c: l.placement.columns }))
    .filter(({ c }) => c.lat !== null && c.lng !== null && c.place_path);
  const pairs: NearPair[] = [];
  for (let x = 0; x < placed.length; x++) {
    for (let y = x + 1; y < placed.length; y++) {
      const p = placed[x].c;
      const q = placed[y].c;
      const d = distanceKm([p.lat!, p.lng!], [q.lat!, q.lng!]) * 1000;
      if (d < metres) pairs.push({ a: placed[x].i, b: placed[y].i, metres: Math.round(d) });
    }
  }
  return pairs;
}

const md = (s: string) =>
  s
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("`", "\\`")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const quoted = (s: string) => `«&nbsp;${md(s)}&nbsp;»`;

function pointLink(lat: number, lng: number): string {
  return `[${lat}, ${lng}](https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng})`;
}

const CLASS_ORDER: LieuClass[] = [
  "address",
  "commune",
  "departement",
  "region",
  "homonym",
  "online",
  "unplaced",
  "generic",
];

function auditionsCell(l: PlannedLieu): string {
  const drafts = l.rows.filter((r) => r.status === "draft").length;
  const noStatus = l.rows.filter((r) => r.status === null).length;
  const notes = [drafts && `${drafts} draft`, noStatus && `${noStatus} no status`].filter(Boolean);
  return notes.length ? `${l.rows.length} (${notes.join(", ")})` : String(l.rows.length);
}

function candidatesText(candidates: PlaceCandidate[], support: Map<string, number>): string {
  return candidates
    .map((c) => {
      const dep = c.departementCode ?? "?";
      const pop = c.population === null ? "population unknown" : `pop. ${c.population}`;
      const held = support.get(dep) ?? 0;
      return `${md(c.name)} (${dep}, ${c.citycode ?? "no code"}; ${pop}; ${held} ${held === 1 ? "lieu" : "lieux"} in ${dep})`;
    })
    .join("; ");
}

export function reviewMarkdown(input: ReviewInput): string {
  const { plan, backfill: b } = input;
  const units = new Map(plan.units.map((u) => [u.id, u]));
  const near = nearDuplicates(plan);
  const nearOf = (i: number) =>
    near.filter((p) => p.a === i || p.b === i).map((p) => (p.a === i ? p.b : p.a));
  const contours = typeof input.contours === "string" ? null : input.contours;

  const flagsOf = (l: PlannedLieu, i: number): string[] => {
    const flags: string[] = [];
    if (!l.online && l.locations.some(ruleCollapses)) flags.push("rule");
    if (!l.online && l.locations.length > 1) flags.push("spellings");
    if (!l.online && curatedPoint(l.key)) flags.push("curated point");
    if (l.placement.columns.place_candidates) flags.push("same-named");
    for (const j of nearOf(i)) flags.push(`near #${j + 1}`);
    const check = contours?.get(i);
    if (check?.kind === "outside") flags.push(`Etalab: ${check.metres} m out`);
    if (check?.kind === "unknown") flags.push("Etalab: no polygon");
    if (l.otherPoints) flags.push("points differ");
    if (l.pointless) flags.push(`${l.pointless.length} without a point`);
    if (l.online && l.locations.length > 1) flags.push("labels differ");
    return flags;
  };

  const out: string[] = [];
  const offlineLieux = plan.lieux.filter((l) => !l.online);
  const onlineLieux = plan.lieux.filter((l) => l.online);
  const byClass = CLASS_ORDER.map(
    (k) => [k, plan.lieux.filter((l) => l.klass === k).length] as const,
  )
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  const offlineRows = offlineLieux.reduce((n, l) => n + l.rows.length, 0);
  const onlineRows = onlineLieux.reduce((n, l) => n + l.rows.length, 0);

  out.push(
    `# Places backfill: review (${b.generated.slice(0, 10)})`,
    "",
    `What the reviewed backfill \`${input.migrationPath}\` (map phase 1, design §B4) writes on each audition never placed, generated by \`scripts/place-backfill/generate.ts\` from \`${b.source}\`, read with the publishable key at ${b.generated}. Sign it off before the migration is pushed: each lieu below lands where its row says, and nowhere else.`,
    "",
    `- LOCATION_RULES hash: \`${b.rules}\` (stamped on the offline rows, \`placed_rules\`).`,
    `- Units: geo.api.gouv.fr (\`geoapi-2026\`). Geocoder: \`${input.ban}\`, text only (no admin pick, no reuse).`,
    `- Etalab cross-check: ${typeof input.contours === "string" ? input.contours : "Etalab's communes, départements and régions 2026, simplified at 50 m"}.`,
    "",
    "## Counts",
    "",
    "| | |",
    "|---|---|",
    `| Auditions read | ${input.rows} (${offlineRows} offline, ${onlineRows} online) |`,
    `| Published / draft / no status | ${input.published} / ${input.drafts} / ${input.nullStatus} |`,
    `| Without \`created_at\` | ${input.nullCreatedAt} |`,
    `| Testimonies without an audition | ${typeof input.orphans === "number" ? input.orphans : md(input.orphans)} |`,
    `| Lieux | ${offlineLieux.length} offline (${b.values.filter((v) => !v.online).length} spellings), ${onlineLieux.length} town halls |`,
    `| By class | ${byClass} |`,
    `| The migration matches | ${b.values.filter((v) => !v.online).length} offline spellings by raw location, ${b.values.filter((v) => v.online).length} town halls by code |`,
    `| Units it inserts (if missing) | ${plan.units.length} |`,
    "",
    "## Lieux",
    "",
    "Class: `address` a point in its commune, `commune`/`departement`/`region` placed at that level only, `homonym` same-named communes were involved, `online` a town hall of the online form (its units; each month at the point it stored, the newest shown, or on no point without one), `unplaced` no commune, département or région by that name, `generic` a text on no point by design. Precision `unplaced`: written on no point.",
    "",
    "| # | Location as typed | Auditions | Lieu key | Class | INSEE | Units | Point | Precision | Flags |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  plan.lieux.forEach((l, i) => {
    // A town hall: its units and precision; the point its newest month stored.
    const c = (l.hall ?? l.placement).columns;
    const { lat, lng } = l.placement.columns;
    const leaf = c.place_unit ? units.get(c.place_unit) : undefined;
    const chain = (c.place_path ?? []).map((id) => md(units.get(id)?.name ?? id)).join(" › ");
    const typed = l.online
      ? `${l.locations.map(md).join("<br>")}<br>(town hall ${l.key})`
      : l.locations.map(md).join("<br>");
    out.push(
      `| ${i + 1} | ${typed} | ${auditionsCell(l)} | ${l.online ? "each its own label" : md(l.key)} | ${l.klass} | ${leaf?.code ?? "—"} | ${chain || "—"} | ${lat !== null && lng !== null ? pointLink(lat, lng) : "—"} | ${c.place_precision} | ${flagsOf(l, i).join(", ") || ""} |`,
    );
  });

  out.push("", "## To look at", "");
  const section = (title: string, lines: string[], none: string) => {
    out.push(`### ${title}`, "", ...(lines.length ? lines : [none]), "");
  };
  const ref = (i: number) => `#${i + 1}`;
  const index = (l: PlannedLieu) => plan.lieux.indexOf(l);

  section(
    "Keyword rules (LOCATION_RULES)",
    offlineLieux.flatMap((l) =>
      l.locations
        .filter(ruleCollapses)
        .map(
          (raw) =>
            `- ${ref(index(l))} ${quoted(raw)} → ${quoted(l.key)}${curatedPoint(l.key) ? ", at the rule's curated point" : ""}.`,
        ),
    ),
    "No keyword rule files a spelling under another name.",
  );
  section(
    "Spellings merged into one lieu",
    offlineLieux
      .filter((l) => l.locations.length > 1)
      .map((l) => `- ${ref(index(l))} ${quoted(l.key)}: ${l.locations.map(quoted).join(", ")}.`),
    "Every lieu has one spelling.",
  );
  section(
    `Lieux within ${NEAR_METRES} m of each other`,
    near.map(
      (p) =>
        `- ${ref(p.a)} ${quoted(plan.lieux[p.a].online ? plan.lieux[p.a].locations[0] : plan.lieux[p.a].key)} and ${ref(p.b)} ${quoted(plan.lieux[p.b].online ? plan.lieux[p.b].locations[0] : plan.lieux[p.b].key)}: ${p.metres} m apart. One place typed two ways? They stay two lieux.`,
    ),
    `No two lieux lie within ${NEAR_METRES} m.`,
  );
  section(
    "Same-named communes",
    offlineLieux
      .filter((l) => l.placement.columns.place_candidates)
      .map((l) => {
        const candidates = l.placement.columns.place_candidates as unknown as PlaceCandidate[];
        const outcome = l.settledOn
          ? `Settled on ${l.settledOn} (match.ts pickHomonym: the published lieux already in a département, else a population five times every namesake's)`
          : "Not settled: on no point; the placement job settles it once the lieux placed around tell";
        return `- ${ref(index(l))} ${quoted(l.key)}: ${candidatesText(candidates, plan.support)}. ${outcome}.`;
      }),
    "No lieu's name is shared by several communes.",
  );
  section(
    "On no point",
    plan.lieux
      .filter((l) => !l.placement.columns.place_path)
      .map((l) => {
        const why =
          l.klass === "generic"
            ? "a generic text (GENERIC_LOCATION): never on the map"
            : l.klass === "homonym"
              ? "same-named communes not settled"
              : l.online
                ? l.hall?.columns.place_path
                  ? "no month read stored a point: each is on no point"
                  : "a code geo.api does not know: every month on no point"
                : "no commune, département or région by that name";
        return `- ${ref(index(l))} ${quoted(l.online ? l.locations[0] : l.key)}: ${why}.`;
      }),
    "Every lieu is on the map.",
  );
  section(
    "Town halls",
    onlineLieux
      .filter((l) => l.otherPoints || l.pointless || l.locations.length > 1)
      .map((l) => {
        const notes: string[] = [];
        if (l.otherPoints) {
          notes.push(
            `${l.otherPoints.length} month(s) stored another point than the newest: each keeps its own`,
          );
        }
        if (l.pointless) {
          notes.push(
            `${l.pointless.length} month(s) with no point of their own: on no point, as the API files them`,
          );
        }
        if (l.locations.length > 1)
          notes.push("months labelled differently: each keeps its own label as lieu key");
        return `- ${ref(index(l))} town hall ${l.key}: ${notes.join("; ")}.`;
      }),
    "Every town hall's months agree on their point and label, and each has one.",
  );
  if (typeof input.contours === "string") {
    section("Etalab cross-check", [`Not run: ${md(input.contours)}.`], "");
  } else {
    const checks = [...input.contours].filter(([, c]) => c.kind !== "inside");
    section(
      "Etalab cross-check",
      checks.map(([i, c]) => {
        const l = plan.lieux[i];
        const unit = l.placement.columns.place_unit;
        return c.kind === "outside"
          ? `- ${ref(i)} lies ${c.metres} m outside ${unit} (the contours are simplified at 50 m: look closer past ~50 m).`
          : `- ${ref(i)}: Etalab has no polygon for ${unit}.`;
      }),
      `Every point lies in its unit's polygon (${input.contours.size} checked).`,
    );
  }

  out.push(
    "## Not covered",
    "",
    "- Online auditions with no verified testimony yet are invisible to the publishable key. Those of a town hall listed here are placed all the same (the migration matches town halls by code), each at the point it stored, or on no point without one, as the placement job would; those of other town halls stay stale for the placement job or the cutover sweep.",
    "- Rows written or moved after the read match nothing (offline rows are matched by their exact text) and stay stale, for the placement job or the cutover sweep. Rows already placed are never touched.",
    "",
  );
  return out.join("\n");
}
