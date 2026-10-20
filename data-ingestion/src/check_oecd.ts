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
 * OECD Deliberative Democracy Database — cite-and-link source (publish: false).
 * The download link moves around on the OECD page, so this script fetches the
 * page, extracts candidate spreadsheet/Airtable links and records them for a
 * human to check the reuse terms. It does NOT download the data.
 */
import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "./lib/http.js";
import { INTERIM_DIR, ensureDir } from "./lib/paths.js";
import { loadRegistry, getSource } from "./lib/sources.js";

const source = getSource(loadRegistry(), "oecd-deliberative");
const pageUrl = source.urls.page;
if (!pageUrl) throw new Error("oecd-deliberative needs urls.page in sources.yml");

console.log(`Fetching ${pageUrl}`);
const outPath = path.join(ensureDir(path.join(INTERIM_DIR, "oecd")), "links.json");

let links: string[] = [];
let error: string | null = null;
try {
  const res = await fetchWithRetry(pageUrl, {}, { retries: 1 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const LINK_RE = /https?:\/\/[^\s"'<>]+/g;
  links = [...new Set(html.match(LINK_RE) ?? [])].filter((url) =>
    /airtable\.com|\.xlsx|\.csv|deliberat/i.test(url),
  );
} catch (err) {
  error = String(err);
}

fs.writeFileSync(
  outPath,
  `${JSON.stringify(
    { page: pageUrl, checked_at: new Date().toISOString(), error, candidates: links },
    null,
    2,
  )}\n`,
);

if (error) {
  // oecd.org sits behind bot protection (403 for non-browser clients as of
  // 2026-07): open the page in a browser and check the link + terms manually.
  console.warn(`page not fetchable (${error}) — check manually in a browser: ${pageUrl}`);
} else if (links.length === 0) {
  console.warn(
    "no candidate database links found — page layout may have changed, inspect manually",
  );
} else {
  console.log("candidate database links (verify reuse terms manually before any download):");
  for (const link of links) console.log(`  - ${link}`);
}
console.log(`recorded → ${outPath}`);
console.log('publish stays "false" in sources.yml until reuse terms are confirmed.');
