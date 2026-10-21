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
 * GDN curation, stage 3: apply the LLM verdicts to the candidates.
 *
 * Reads the per-testimony verdicts produced by the gdn-testimony-curation
 * workflow (saved to data/interim/gdn/curation/verdicts.json) and joins them
 * by id onto candidates.ndjson, producing:
 *   - curated.ndjson  — kept testimonies only, with their location, testimony
 *     text, topics, and anonymity flags (personal_data / redaction_needed).
 *   - rejected.ndjson — dropped testimonies with the reason.
 *   - curated-report.json — the funnel + keep/drop + anonymity tallies.
 *
 * Usage: npm run curate:gdn:apply
 */
import fs from "node:fs";
import path from "node:path";
import { readNdjson, createNdjsonWriter } from "./lib/ndjson.js";
import { INTERIM_DIR } from "./lib/paths.js";

const DIR = path.join(INTERIM_DIR, "gdn", "curation");
const VERDICTS = path.join(DIR, "verdicts.json");

if (!fs.existsSync(VERDICTS)) {
  console.error(
    `missing ${VERDICTS} — save the gdn-testimony-curation workflow's "merged" array there first`,
  );
  process.exit(1);
}

interface Verdict {
  id: string;
  keep: boolean;
  quality: string;
  adapted_to_ac: boolean;
  format_ok: boolean;
  is_placeholder: boolean;
  topics: string[];
  reason: string;
  personal_data: boolean;
  pd_examples: string[];
  redaction_needed: boolean;
  pd_severity: string;
}

const verdicts = new Map<string, Verdict>(
  (JSON.parse(fs.readFileSync(VERDICTS, "utf8")) as Verdict[]).map((v) => [v.id, v]),
);

const keptWriter = createNdjsonWriter(path.join(DIR, "curated.ndjson"));
const rejWriter = createNdjsonWriter(path.join(DIR, "rejected.ndjson"));

const report = {
  candidates: 0,
  no_verdict: 0,
  kept: 0,
  rejected: 0,
  kept_with_personal_data: 0,
  redaction_needed: 0,
  by_severity: { none: 0, low: 0, medium: 0, high: 0 } as Record<string, number>,
  topics: {} as Record<string, number>,
};

for await (const cand of readNdjson<Record<string, unknown> & { id: string }>(
  path.join(DIR, "candidates.ndjson"),
)) {
  report.candidates++;
  const v = verdicts.get(cand.id);
  if (!v) {
    report.no_verdict++;
    // No verdict (batch failed): keep for a re-run rather than silently drop.
    await rejWriter.write({
      ...cand,
      reason: "no LLM verdict (batch missing) — re-run",
    });
    continue;
  }
  if (!v.keep) {
    report.rejected++;
    await rejWriter.write({
      id: cand.id,
      reason: v.reason,
      quality: v.quality,
      adapted_to_ac: v.adapted_to_ac,
      format_ok: v.format_ok,
      is_placeholder: v.is_placeholder,
    });
    continue;
  }
  report.kept++;
  if (v.personal_data) report.kept_with_personal_data++;
  if (v.redaction_needed) report.redaction_needed++;
  report.by_severity[v.pd_severity] = (report.by_severity[v.pd_severity] ?? 0) + 1;
  for (const t of v.topics) report.topics[t] = (report.topics[t] ?? 0) + 1;

  await keptWriter.write({
    ...cand,
    curation: {
      topics: v.topics,
      quality: v.quality,
      reason: v.reason,
      personal_data: v.personal_data,
      pd_examples: v.pd_examples,
      redaction_needed: v.redaction_needed,
      pd_severity: v.pd_severity,
    },
  });
}
await keptWriter.close();
await rejWriter.close();

fs.writeFileSync(path.join(DIR, "curated-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`\ncurated (kept) → ${path.join(DIR, "curated.ndjson")}`);
console.log(`rejected → ${path.join(DIR, "rejected.ndjson")}`);
