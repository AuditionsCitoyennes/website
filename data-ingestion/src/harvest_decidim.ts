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
 * Harvests meetings from the Decidim instances declared in data/sources.yml
 * (kind: decidim) via their public GraphQL API (<host>/api).
 *
 * Decidim versions differ across instances, so the Query type is introspected
 * first and only the containers that exist (participatoryProcesses and/or
 * assemblies) are walked. Meetings are paginated 50 at a time per component.
 *
 * License rule: everything harvested here stays display-only-with-link until
 * the instance's reuse terms are confirmed in sources.yml (publish flag).
 *
 * Usage: npm run harvest:decidim [-- --source decidim-meta] [-- --max 500]
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { fetchWithRetry, RateLimiter } from "./lib/http.js";
import { createNdjsonWriter } from "./lib/ndjson.js";
import { INTERIM_DIR, ensureDir } from "./lib/paths.js";
import { loadRegistry, type Source } from "./lib/sources.js";
import { saveManifestEntry, repoRelative } from "./lib/manifest.js";

const { values: flags } = parseArgs({
  options: {
    source: { type: "string" },
    max: { type: "string" },
  },
});
const maxMeetings = flags.max ? Number(flags.max) : Infinity;
const limiter = new RateLimiter(2); // be polite: 2 req/s per run

interface GqlError {
  message: string;
}

async function gql<T>(
  host: string,
  query: string,
  variables?: Record<string, unknown>,
  { allowPartial = false } = {},
): Promise<T> {
  await limiter.take();
  const res = await fetchWithRetry(
    `${host}/api`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    { retries: 3 },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}/api`);
  const body = (await res.json()) as { data?: T; errors?: GqlError[] };
  if (body.errors?.length) {
    // Decidim returns partial data + errors for online meetings (null
    // coordinates on a non-nullable type) and private meetings — tolerate.
    if (!allowPartial || !body.data) {
      throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    console.warn(`    (page with ${body.errors.length} tolerated field error(s))`);
  }
  if (!body.data) throw new Error(`empty GraphQL response from ${host}`);
  return body.data;
}

async function queryFieldNames(host: string): Promise<Set<string> | null> {
  try {
    const data = await gql<{ __type: { fields: { name: string }[] } | null }>(
      host,
      `query { __type(name: "Query") { fields { name } } }`,
    );
    return new Set((data.__type?.fields ?? []).map((f) => f.name));
  } catch (err) {
    // Some instances (e.g. meta.decidim.org) disable introspection; the
    // caller falls back to probing the container fields directly. The error
    // message is localized ("introspection" / "introspecció" / …).
    if (/introspec/i.test(String(err))) return null;
    throw err;
  }
}

interface ContainerRef {
  id: string;
  slug: string;
}

/** Lists containers, or null when the field doesn't exist on this Decidim version. */
async function probeContainers(host: string, listField: string): Promise<ContainerRef[] | null> {
  try {
    const data = await gql<Record<string, ContainerRef[] | null>>(
      host,
      `query { ${listField} { id slug } }`,
    );
    return data[listField] ?? [];
  } catch (err) {
    if (/doesn't exist|cannot query field|undefined field/i.test(String(err))) return null;
    throw err;
  }
}

interface TranslatedField {
  fr?: string | null;
  en?: string | null;
  es?: string | null;
  ca?: string | null;
}

function pickTranslation(
  field: TranslatedField | null | undefined,
  locales: string[],
): string | null {
  if (!field) return null;
  for (const locale of locales) {
    const v = field[locale as keyof TranslatedField];
    if (v) return v;
  }
  return null;
}

const TRANSLATED = `{
  fr: translation(locale: "fr")
  en: translation(locale: "en")
  es: translation(locale: "es")
  ca: translation(locale: "ca")
}`;

const MEETINGS_PAGE = `
  meetings(first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id
      title ${TRANSLATED}
      description ${TRANSLATED}
      startTime
      endTime
      address
      location ${TRANSLATED}
      coordinates { latitude longitude }
    } }
  }`;

// participatoryProcess is addressed by slug; assembly only accepts id.
function containerQuery(containerField: string, byId: boolean): string {
  const varDef = byId ? "$id: ID!" : "$slug: String!";
  const arg = byId ? "id: $id" : "slug: $slug";
  return `query Meetings(${varDef}, $after: String) {
    ${containerField}(${arg}) {
      components {
        ... on Meetings { id ${MEETINGS_PAGE} }
      }
    }
  }`;
}

interface MeetingNode {
  id: string;
  title: TranslatedField | null;
  description: TranslatedField | null;
  startTime: string | null;
  endTime: string | null;
  address: string | null;
  location: TranslatedField | null;
  coordinates: { latitude: number; longitude: number } | null;
}

interface ComponentPage {
  id?: string;
  meetings?: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: MeetingNode }[];
  };
}

async function harvestInstance(source: Source): Promise<void> {
  const host = source.decidim!.host.replace(/\/$/, "");
  const locales = source.decidim!.locales;
  console.log(`\n${source.id} — ${host}`);

  const fields = await queryFieldNames(host);
  if (fields === null) console.log("  introspection disabled — probing container fields directly");
  const containers = [
    {
      field: "participatoryProcess",
      listField: "participatoryProcesses",
      pathSegment: "processes",
      byId: false,
    },
    { field: "assembly", listField: "assemblies", pathSegment: "assemblies", byId: true },
  ].filter((c) => fields === null || fields.has(c.listField));

  const outPath = path.join(ensureDir(path.join(INTERIM_DIR, "decidim")), `${source.id}.ndjson`);
  const writer = createNdjsonWriter(outPath);
  const retrievedAt = new Date().toISOString();
  let total = 0;

  for (const container of containers) {
    const refs = await probeContainers(host, container.listField);
    if (refs === null) {
      console.log(`  ${container.listField}: not exposed on this instance`);
      continue;
    }
    console.log(`  ${container.listField}: ${refs.length} containers`);

    for (const ref of refs) {
      if (total >= maxMeetings) break;
      const slug = ref.slug;
      let after: string | null = null;
      let hasNext = true;
      while (hasNext && total < maxMeetings) {
        let data: Record<string, { components: (ComponentPage | null)[] | null } | null>;
        try {
          data = await gql(
            host,
            containerQuery(container.field, container.byId),
            container.byId ? { id: ref.id, after } : { slug, after },
            { allowPartial: true },
          );
        } catch (err) {
          console.warn(`  ! ${container.field}/${slug}: ${String(err)} — skipped`);
          break;
        }
        hasNext = false;
        const components = data[container.field]?.components ?? [];
        for (const component of components) {
          const page = component?.meetings;
          if (!page) continue;
          for (const edge of page.edges) {
            const node = edge?.node;
            if (!node) continue; // private/errored meeting nulled out by the API
            if (total >= maxMeetings) break;
            total++;
            await writer.write({
              instance: source.id,
              host,
              container_type: container.field,
              container_slug: slug,
              component_id: component?.id ?? null,
              url:
                component?.id != null
                  ? `${host}/${container.pathSegment}/${slug}/f/${component.id}/meetings/${node.id}`
                  : null,
              id: node.id,
              title: pickTranslation(node.title, locales),
              description: pickTranslation(node.description, locales),
              start_time: node.startTime,
              end_time: node.endTime,
              address: node.address,
              location: pickTranslation(node.location, locales),
              latitude: node.coordinates?.latitude ?? null,
              longitude: node.coordinates?.longitude ?? null,
              retrieved_at: retrievedAt,
            });
          }
          if (page.pageInfo.hasNextPage) {
            hasNext = true;
            after = page.pageInfo.endCursor;
          }
        }
      }
    }
  }

  await writer.close();
  saveManifestEntry({
    source: source.id,
    resource: "meetings",
    url: `${host}/api`,
    path: repoRelative(outPath),
    sha256: "-", // API harvest, not a single artifact
    bytes: 0,
    retrieved_at: retrievedAt,
  });
  console.log(`  ${total} meetings → ${outPath}`);
  if (total >= maxMeetings) console.warn(`  ! capped at --max ${maxMeetings}; harvest is partial`);
}

const registry = loadRegistry();
const targets = registry.sources.filter(
  (s) => s.kind === "decidim" && (!flags.source || s.id === flags.source),
);
if (targets.length === 0) {
  console.error("no decidim sources matched");
  process.exit(1);
}
for (const source of targets) {
  try {
    await harvestInstance(source);
  } catch (err) {
    console.error(`${source.id}: harvest failed — ${String(err)}`);
    process.exitCode = 1;
  }
}
