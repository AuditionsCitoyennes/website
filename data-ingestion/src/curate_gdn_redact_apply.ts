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
 * GDN curation, stage 4: apply the anonymisation.
 *
 * Reads the redaction verdicts from the gdn-redaction workflow (saved to
 * data/interim/gdn/curation/redactions.json) and overlays them onto
 * curated.ndjson, producing curated-anonymised.ndjson: the kept testimonies
 * with personal data stripped (role labels instead of names, Article-9 detail
 * generalised). Rows without flagged PII pass through unchanged.
 *
 * Usage: npm run curate:gdn:redact:apply
 */
import fs from "node:fs";
import path from "node:path";
import { readNdjson, createNdjsonWriter } from "./lib/ndjson.js";
import { INTERIM_DIR } from "./lib/paths.js";

const DIR = path.join(INTERIM_DIR, "gdn", "curation");
const REDACTIONS = path.join(DIR, "redactions.json");

if (!fs.existsSync(REDACTIONS)) {
  console.error(
    `missing ${REDACTIONS} — save the gdn-redaction workflow's "results" array there first`,
  );
  process.exit(1);
}

interface Redaction {
  id: string;
  redacted: { deroulement: string; constats: string; propositions: string; avis: string };
  redactions: { original: string; replacement: string; kind: string }[];
  residual_risk: string;
  verified_acceptable: boolean;
  residual_leaks: string[];
}

const byId = new Map<string, Redaction>(
  (JSON.parse(fs.readFileSync(REDACTIONS, "utf8")) as Redaction[]).map((r) => [r.id, r]),
);

const out = createNdjsonWriter(path.join(DIR, "curated-anonymised.ndjson"));
const report = {
  kept: 0,
  anonymised: 0,
  passed_through: 0,
  still_flagged_by_verifier: 0,
  residual_risk: { none: 0, low: 0, medium: 0, high: 0 } as Record<string, number>,
  needs_human_review: [] as string[],
};

for await (const item of readNdjson<Record<string, unknown> & { id: string }>(
  path.join(DIR, "curated.ndjson"),
)) {
  report.kept++;
  const red = byId.get(item.id);
  if (red) {
    report.anonymised++;
    report.residual_risk[red.residual_risk] = (report.residual_risk[red.residual_risk] ?? 0) + 1;
    if (!red.verified_acceptable || red.residual_leaks.length > 0) {
      report.still_flagged_by_verifier++;
      report.needs_human_review.push(item.id);
    }
    await out.write({
      ...item,
      testimony: red.redacted,
      redaction_applied: true,
      redaction: {
        changes: red.redactions,
        residual_risk: red.residual_risk,
        verified_acceptable: red.verified_acceptable,
        residual_leaks: red.residual_leaks,
      },
    });
  } else {
    report.passed_through++;
    await out.write({ ...item, redaction_applied: false });
  }
}
await out.close();

fs.writeFileSync(
  path.join(DIR, "anonymisation-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
console.log(`\nanonymised curated set → ${path.join(DIR, "curated-anonymised.ndjson")}`);
if (report.needs_human_review.length > 0) {
  console.warn(
    `${report.needs_human_review.length} item(s) still flagged by the verifier — HUMAN REVIEW before publish: ${report.needs_human_review.join(", ")}`,
  );
}
