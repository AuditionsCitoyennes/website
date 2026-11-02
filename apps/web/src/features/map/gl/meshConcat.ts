// The plateau's boundary line groups (PlateauWallLayer.setGeometry), packed
// into one buffer per regime with ac:mesh=concat (plateau/meshSwitch.ts): one
// Float32Array of the total length, each group copied in with one
// TypedArray.set — no push value by value into a second number[], no third
// copy at the end. The values are the same float32 roundings as
// `new Float32Array(numbers)`. Pure: no DOM, no GL.

/** The groups end to end in one Float32Array; `starts[i]` is the FLOAT offset
 *  of group i (divide by the stride for a vertex index). The caller passes the
 *  non-empty groups only, in its draw order, so `starts` lines up with its
 *  ranges. */
export function concatGroups(groups: readonly (readonly number[])[]): {
  array: Float32Array<ArrayBuffer>;
  starts: number[];
} {
  let total = 0;
  for (const g of groups) total += g.length;
  const array = new Float32Array(total);
  const starts: number[] = [];
  let offset = 0;
  for (const g of groups) {
    starts.push(offset);
    array.set(g, offset);
    offset += g.length;
  }
  return { array, starts };
}
