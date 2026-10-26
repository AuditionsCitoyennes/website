/** PostgREST's max_rows (supabase/config.toml): past it a bare read is silently cut short. */
export const PAGE = 1000;

/** One supabase-js read, as far as paging needs it. */
interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Every row of a read, fetched one page of PAGE rows after the other until a
 * short page. `page(from, to)` is the query with `.range(from, to)` applied;
 * its order must end on a unique column, or rows repeat or go missing across
 * pages. Settles like a single read: all the rows, or the first error.
 */
export async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<{ data: T[]; error: null } | { data: null; error: { message: string } }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { data: null, error };
    if (data) for (const row of data) rows.push(row);
    if (!data || data.length < PAGE) return { data: rows, error: null };
  }
}
