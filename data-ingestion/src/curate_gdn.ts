/*
 * Auditions Citoyennes — data ingestion pipeline
 * Copyright (C) 2026 Auditions Citoyennes
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed WITHOUT ANY WARRANTY;
 * see the GNU Affero General Public License for more details:
 * <https://www.gnu.org/licenses/>.
 */

/**
 * GDN curation, stage 1 (deterministic, reproducible).
 *
 * The audition-like object for AC is a located, dated assembly WITH a real
 * account of what was said. In the GDN data:
 *   - events.json  = the meeting (precise address for ~90%), but its `body` is
 *     only a pre-meeting announcement — NOT testimony.
 *   - cr-ril.json  = the compte-rendu = the actual testimony (déroulé, constats,
 *     propositions, débats), joined to its event by the platform URL.
 *
 * This step joins compte-rendu → event and keeps only rows that have BOTH a
 * PERFECT location (event geocoded by BAN to housenumber/street/venue) AND a
 * SUBSTANTIVE testimony (not empty, not a "voir le document" pointer). The
 * survivors are the candidates handed to the LLM curation stage (stage 2:
 * adapted-to-AC? personal names / anonymity? format?).
 *
 * Writes data/interim/gdn/curation/{candidates.ndjson, report.json,
 * batches/batch-NNN.json} + prints the batch manifest for the LLM stage.
 */
import fs from "node:fs";
import path from "node:path";
import { readNdjson, createNdjsonWriter } from "./lib/ndjson.js";
import { htmlToText } from "./lib/html.js";
import { INTERIM_DIR, ensureDir } from "./lib/paths.js";

const GDN = path.join(INTERIM_DIR, "gdn");
const OUT = ensureDir(path.join(GDN, "curation"));
const BATCH_DIR = ensureDir(path.join(OUT, "batches"));
const BATCH_SIZE = 20;
const LLM_TEXT_CAP = 1600; // truncate long fields for the classifier

// Exact compte-rendu field names (accent-stripped by the GDN export).
const F = {
  titre: "Titre",
  joinUrl: "Renseignez le lien de votre reunion sur la plateforme",
  lieuDate: "Indiquez le lieu et la date de votre reunion",
  themes: "Sur quel s theme s votre reunion a t elle porte",
  participants: "Combien de participants etaient presents",
  deroulement: "Comment la reunion sest elle passee",
  constats: "Quels ont ete les constats ou les diagnostics exprimes sur les themes du debat",
  propositions: "Quelles sont les propositions qui ont emerge des discussions",
  avis: "Des avis divers voire opposes se sont ils exprimes",
  ville: "Ville",
  cp: "Code postal",
  documents: "Documents",
  supports: "Supports",
  moderation: "Motif de modération",
  anonyme: "Anonyme",
} as const;

const PRECISE = new Set(["housenumber", "street", "venue"]);
// "see the document" pointers — a testimony that is only this has nothing more.
const PLACEHOLDER =
  /\b(voir|cf\.?|consulter|se r[ée]f[ée]rer|reportez|ci[- ]?joint|pi[èe]ce jointe|document|annexe|compte[- ]rendu|le cr\b|\.pdf|fichier joint)\b/i;

function txt(v: unknown): string {
  return v == null ? "" : htmlToText(String(v));
}
function truncate(s: string): string {
  return s.length > LLM_TEXT_CAP ? `${s.slice(0, LLM_TEXT_CAP)}…` : s;
}

/** Combined free-text testimony, and whether it is more than a doc-pointer. */
function testimonyOf(cr: Record<string, unknown>) {
  const parts = {
    deroulement: txt(cr[F.deroulement]),
    constats: txt(cr[F.constats]),
    propositions: txt(cr[F.propositions]),
    avis: txt(cr[F.avis]),
  };
  const combined = Object.values(parts).filter(Boolean).join("\n\n").trim();
  const empty = combined.length < 25;
  // strip the pointer words; if almost nothing survives, it is a placeholder
  const core = combined.replace(/\b(cf\.?|voir|document|joint|compte[- ]rendu|cr)\b/gi, "").trim();
  const placeholder =
    !empty && combined.length < 200 && PLACEHOLDER.test(combined) && core.length < 25;
  return { parts, combined, empty, placeholder, substantive: !empty && !placeholder };
}

// --- event index: url -> perfect-location payload (BAN precise coords) --------
interface EventLoc {
  event_id: string;
  precision: string;
  lat: number | null;
  lng: number | null;
  address_raw: string | null;
  street: string | null;
  city: string | null;
  postcode: string | null;
  title: string | null;
}
type GeoEvent = Record<string, unknown> & {
  _geo?: {
    precision?: string;
    ban?: {
      lat?: number;
      lng?: number;
      housenumber?: string | null;
      street?: string | null;
      postcode?: string | null;
      city?: string | null;
    } | null;
  };
};

const byUrl = new Map<string, EventLoc>();
for await (const ev of readNdjson<GeoEvent>(path.join(GDN, "events.geocoded.ndjson"))) {
  const url = typeof ev.url === "string" ? ev.url.trim() : "";
  if (!url) continue;
  const geo = ev._geo ?? {};
  const ban = geo.ban ?? null;
  byUrl.set(url, {
    event_id: String(ev.id ?? ""),
    precision: geo.precision ?? "unknown",
    lat: ban?.lat ?? null,
    lng: ban?.lng ?? null,
    address_raw: typeof ev.fullAddress === "string" ? ev.fullAddress : null,
    street: ban ? [ban.housenumber, ban.street].filter(Boolean).join(" ") || null : null,
    city: ban?.city ?? null,
    postcode: ban?.postcode ?? null,
    title: typeof ev.title === "string" ? ev.title : null,
  });
}

// --- walk comptes-rendus, apply the funnel -----------------------------------
const report = {
  comptes_rendus: 0,
  with_join_url: 0,
  join_matches_event: 0,
  joined_precise_location: 0,
  precise_and_substantive: 0,
  dropped: {
    no_join_url: 0,
    join_no_event_match: 0,
    location_not_perfect: 0,
    empty_testimony: 0,
    placeholder_only: 0,
  },
  moderated_kept: 0,
};

const candWriter = createNdjsonWriter(path.join(OUT, "candidates.ndjson"));
interface Batable {
  id: string;
  event_id: string;
  title: string;
  city: string;
  cp: string;
  participants: string;
  themes: string;
  lieu_date: string;
  moderated: boolean;
  has_attachment: boolean;
  deroulement: string;
  constats: string;
  propositions: string;
  avis: string;
}
const batch: Batable[] = [];
let candCount = 0;

for await (const cr of readNdjson<Record<string, unknown>>(
  path.join(GDN, "cr-ril.scrubbed.ndjson"),
)) {
  report.comptes_rendus++;
  const url = txt(cr[F.joinUrl]).trim();
  if (!url) {
    report.dropped.no_join_url++;
    continue;
  }
  report.with_join_url++;
  const ev = byUrl.get(url);
  if (!ev) {
    report.dropped.join_no_event_match++;
    continue;
  }
  report.join_matches_event++;
  if (!PRECISE.has(ev.precision)) {
    report.dropped.location_not_perfect++;
    continue;
  }
  report.joined_precise_location++;

  const t = testimonyOf(cr);
  if (t.empty) {
    report.dropped.empty_testimony++;
    continue;
  }
  if (t.placeholder) {
    report.dropped.placeholder_only++;
    continue;
  }
  report.precise_and_substantive++;

  const moderated = Boolean(txt(cr[F.moderation]));
  if (moderated) report.moderated_kept++;
  const hasAttachment = Boolean(txt(cr[F.documents]) || txt(cr[F.supports]));
  const id = `gdn-cr-${candCount.toString().padStart(5, "0")}`;

  await candWriter.write({
    id,
    source: "gdn",
    event_id: ev.event_id,
    event_url: url,
    title: txt(cr[F.titre]) || ev.title || "Réunion locale",
    location: {
      lat: ev.lat,
      lng: ev.lng,
      precision: ev.precision,
      address_raw: ev.address_raw,
      street: ev.street,
      city: ev.city,
      postcode: ev.postcode,
    },
    cr: {
      lieu_date: txt(cr[F.lieuDate]),
      themes: txt(cr[F.themes]),
      participants: txt(cr[F.participants]),
      ville: txt(cr[F.ville]),
      code_postal: txt(cr[F.cp]),
      anonyme: txt(cr[F.anonyme]),
    },
    testimony: t.parts,
    testimony_len: t.combined.length,
    flags: { moderated, has_attachment: hasAttachment },
  });

  batch.push({
    id,
    event_id: ev.event_id,
    title: txt(cr[F.titre]) || ev.title || "",
    city: ev.city ?? txt(cr[F.ville]),
    cp: ev.postcode ?? txt(cr[F.cp]),
    participants: txt(cr[F.participants]),
    themes: truncate(txt(cr[F.themes])),
    lieu_date: txt(cr[F.lieuDate]),
    moderated,
    has_attachment: hasAttachment,
    deroulement: truncate(t.parts.deroulement),
    constats: truncate(t.parts.constats),
    propositions: truncate(t.parts.propositions),
    avis: truncate(t.parts.avis),
  });
  candCount++;
}
await candWriter.close();

// --- write batch files for the LLM curation stage ----------------------------
fs.rmSync(BATCH_DIR, { recursive: true, force: true });
ensureDir(BATCH_DIR);
const manifest: string[] = [];
for (let i = 0; i < batch.length; i += BATCH_SIZE) {
  const n = manifest.length;
  const file = path.join(BATCH_DIR, `batch-${n.toString().padStart(3, "0")}.json`);
  fs.writeFileSync(file, JSON.stringify(batch.slice(i, i + BATCH_SIZE), null, 1));
  manifest.push(file);
}
fs.writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, "batch-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);

console.log(JSON.stringify(report, null, 2));
console.log(`\ncandidates: ${candCount} → ${path.join(OUT, "candidates.ndjson")}`);
console.log(`batches: ${manifest.length} files of ≤${BATCH_SIZE} → ${BATCH_DIR}`);
console.log(`manifest → ${path.join(OUT, "batch-manifest.json")}`);
