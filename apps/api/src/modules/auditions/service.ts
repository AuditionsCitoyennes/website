import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCanonicalLocation,
  type AuditionWithCount,
  type Database,
  type OnlinePlace,
} from "@ac/shared";
import { publicClient } from "../../lib/supabase";

/**
 * Where an audition is filed on the map. An online audition's location is its
 * town hall's name, already unique and exact: it is never run through the
 * keyword rules of getCanonicalLocation (they would turn "Mairie de
 * Montbron" into Bron's médiathèque).
 */
export function placeKeyOf(a: { location: string; audition_en_ligne?: boolean | null }): string {
  return a.audition_en_ligne ? a.location : getCanonicalLocation(a.location);
}

/** An online audition's town hall, as stored with it (null for any other). */
export function onlinePlaceOf(a: {
  audition_en_ligne?: boolean | null;
  place?: unknown;
}): OnlinePlace | null {
  if (!a.audition_en_ligne || !a.place || typeof a.place !== "object") return null;
  const p = a.place as Partial<OnlinePlace>;
  return typeof p.lat === "number" && typeof p.lng === "number" ? (p as OnlinePlace) : null;
}

/** Published auditions with their visible (verified) testimony counts. */
export async function fetchPublishedAuditions(): Promise<AuditionWithCount[]> {
  const { data, error } = await publicClient
    .from("auditions")
    .select("*, testimonies(count)")
    .eq("status", "published")
    .order("date", { ascending: false });
  if (error) throw new Error(error.message);

  return (
    (data ?? [])
      .map((row) => {
        const { testimonies, ...audition } = row as typeof row & {
          testimonies?: { count: number }[];
        };
        return { ...audition, testimony_count: testimonies?.[0]?.count ?? 0 };
      })
      // An online audition is public once it holds a verified testimony. The
      // database already hides it until then; this holds even if it did not.
      .filter((a) => !(a.audition_en_ligne && a.testimony_count === 0))
  );
}

/**
 * Whether an audition is gone — asked after one of its testimonies was
 * deleted: the database deletes an audition along with its last testimony
 * (trigger drop_emptied_audition). Only meaningful for an audition the same
 * client could see just before; false when the lookup fails, which proves
 * nothing.
 */
export async function auditionGone(
  client: SupabaseClient<Database>,
  auditionId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("auditions")
    .select("id")
    .eq("id", auditionId)
    .maybeSingle();
  return !error && !data;
}
