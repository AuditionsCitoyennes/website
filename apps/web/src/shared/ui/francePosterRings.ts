// The poster's outline (francePoster.ts) as rings of points, for a curtain
// that draws it projected (shared/ui/CurtainPoster.vue, "carte"). The build
// writes each région as absolute moves and relative lines only (M, l, z);
// an absolute L is read too, any other command is refused.
//
// Pure: loadable under node (francePosterRings.test.ts).

export type PosterRing = [number, number][];

/** The rings of one SVG path's data, in its own units. */
export function posterRings(d: string): PosterRing[] {
  const rings: PosterRing[] = [];
  let ring: PosterRing | null = null;
  let x = 0;
  let y = 0;
  for (const m of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const cmd = m[1];
    const nums = (m[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi) ?? []).map(Number);
    if (cmd === "z" || cmd === "Z") {
      ring = null;
      continue;
    }
    if (!"MmLl".includes(cmd) || nums.length % 2) throw new Error(`poster path: "${cmd}" unread`);
    for (let k = 0; k < nums.length; k += 2) {
      // After a move, further pairs are lines (absolute after M, relative after m).
      const rel = cmd === "l" || cmd === "m";
      x = rel ? x + nums[k] : nums[k];
      y = rel ? y + nums[k + 1] : nums[k + 1];
      if ((cmd === "M" || cmd === "m") && k === 0) {
        ring = [];
        rings.push(ring);
      }
      if (!ring) {
        ring = [[x, y]];
        rings.push(ring);
      } else ring.push([x, y]);
    }
  }
  return rings;
}
