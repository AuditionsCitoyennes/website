// Whether db:check may compare a seeded database with the fixtures
// (scripts/db-checks/seed.ts): only while it is as the seed left it, and
// under the LOCATION_RULES the check expects. The seed's fake_seed_loaded
// entry records both (generate.ts): the fingerprint of its place data as
// loaded, and the rules hash its rows are stamped with. A database used
// since (the placement job ran, an admin wrote) fails the first; one seeded
// before a LOCATION_RULES change, even one that moves no seed lieu, the
// second. Locally the comparison is then skipped, which npm run db:reset
// brings back; in CI, which always seeds afresh, it fails.

/** What the seed recorded about its place data. */
export interface SeedStamp {
  /** The fingerprint of the place data as loaded (scripts/seed/fingerprint.ts). */
  places?: string;
  /** The LOCATION_RULES hash the rows are stamped with (absent before it was recorded). */
  rules?: string;
}

export type SeedGate = { compare: true } | { compare: false; error: string | null; note: string };

export function seedGate(
  stamp: SeedStamp,
  now: { fingerprint: string; rules: string },
  ci: boolean,
): SeedGate {
  const skip = (error: string, note: string): SeedGate => ({
    compare: false,
    error: ci ? error : null,
    note: `${note}: the rest is skipped`,
  });
  if (stamp.places !== now.fingerprint) {
    return skip(
      "the database's place data is not what the seed loaded (fingerprint differs)",
      "the place data changed since the seed was loaded",
    );
  }
  if (stamp.rules !== now.rules) {
    const then = stamp.rules ? `LOCATION_RULES ${stamp.rules}` : "LOCATION_RULES not recorded";
    return skip(
      `the seed was loaded under ${then}, the check runs under ${now.rules}`,
      `seeded under ${then}, ${now.rules} now (npm run db:reset to compare again)`,
    );
  }
  return { compare: true };
}
