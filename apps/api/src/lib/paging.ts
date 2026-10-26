/**
 * PostgREST's max_rows: past it a read, an embedded list included, is cut
 * short without an error. 1000 is the local stack's (supabase/config.toml)
 * and Supabase's default. A paged read ends at a page shorter than PAGE, so
 * a hosted project's API "Max rows" setting must not be lower: the reads
 * would then stop after their first page, silently.
 */
export const PAGE = 1000;

/** One supabase-js read, as far as paging needs it. */
interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Every row of a read, one keyset page after the other until a short page.
 * `page(last)` reads the PAGE rows (`.limit(PAGE)`) that follow `last` in the
 * read's order, the first PAGE when `last` is undefined; the order must end
 * on a unique column. A keyset rather than offsets: a row written or deleted
 * between two pages does not shift the next one, so a row that keeps its
 * place is read once. Settles like a single read: all the rows, or the first
 * error.
 */
export async function selectAll<T>(
  page: (last: T | undefined) => PromiseLike<PageResult<T>>,
): Promise<{ data: T[]; error: null } | { data: null; error: { message: string } }> {
  const rows: T[] = [];
  let last: T | undefined;
  for (;;) {
    const { data, error } = await page(last);
    if (error) return { data: null, error };
    if (data) for (const row of data) rows.push(row);
    if (!data || data.length < PAGE) return { data: rows, error: null };
    last = data[data.length - 1];
  }
}

/** A value inside a PostgREST `or`/`and` filter, quoted: a timestamp's `:` and `.` need it. */
export const quoted = (value: string) => `"${value}"`;
