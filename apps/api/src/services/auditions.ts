import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ac/shared";

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
