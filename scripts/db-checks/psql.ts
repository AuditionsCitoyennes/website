// Runs SQL through psql: the command in PSQL, or psql on DATABASE_URL.
//
//   CI:     DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
//   local:  PSQL="docker exec -i supabase_db_<project_id> psql -U postgres -d postgres"
//
// Local databases only: these checks read every testimony and write inside
// rolled-back transactions, so a hosted project is refused.

import { spawnSync } from "node:child_process";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function command(): string {
  const custom = process.env.PSQL;
  if (custom) {
    if (/supabase\.(co|com)\b/i.test(custom)) {
      throw new Error(
        "PSQL points at a hosted Supabase project: the checks run on local databases only.",
      );
    }
    return custom;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set PSQL (a psql command) or DATABASE_URL (a local database).");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a URL.");
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`DATABASE_URL names ${host}: the checks run on local databases only.`);
  }
  return 'psql "$DATABASE_URL"';
}

/** Every script starts here: UTF-8 both ways, nothing found by search_path. */
const PREAMBLE = "set client_encoding = 'UTF8';\nset search_path = '';\n";

/** Runs a script; returns what it printed (unaligned, tuples only). By default
 *  through PSQL or DATABASE_URL; `psql` names another command. */
export function runSql(sql: string, psql = command()): string {
  const r = spawnSync("sh", ["-c", `${psql} -X -q -A -t -v ON_ERROR_STOP=1`], {
    input: PREAMBLE + sql,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`psql exited with ${r.status}:\n${r.stderr.trim()}`);
  return r.stdout;
}

/** Runs a script whose selects each print one json/jsonb value; returns them in order. */
export function sqlJson<T = unknown>(sql: string, psql?: string): T[] {
  return runSql(sql, psql)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** A SQL string literal. */
export function lit(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}
