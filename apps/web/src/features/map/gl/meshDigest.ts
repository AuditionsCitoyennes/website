// A fingerprint of the plateau's mesh (PlateauWallLayer.meshDigest, the
// testing tools' `__acMeshHash`): FNV-1a 32-bit over the BYTES of each typed
// array, so two mesh assemblies (ac:mesh, plateau/meshSwitch.ts) can be proven
// to hand the GPU the same bits — `-0` and NaN included, which a comparison of
// values cannot see. Pure: no DOM, no GL. Only reached under __TEST_TOOLS__,
// so a production build carries none of it.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit of `bytes`, continued from `h` (unsigned). */
export function fnv1a(bytes: Uint8Array, h = FNV_OFFSET): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], FNV_PRIME);
  return h >>> 0;
}

const hex = (h: number) => h.toString(16).padStart(8, "0");

/** A part's hash, as 8 hex digits: a typed array by its bytes, a string by its
 *  UTF-8 bytes, a missing array as the literal part "absent". */
export function hashPart(part: ArrayBufferView | string | null | undefined): string {
  if (part == null) return hex(fnv1a(new TextEncoder().encode("absent")));
  if (typeof part === "string") return hex(fnv1a(new TextEncoder().encode(part)));
  return hex(fnv1a(new Uint8Array(part.buffer, part.byteOffset, part.byteLength)));
}

/** Every part's hash, by name, and the total: the hash of the parts in the
 *  order given. */
export function digestParts(
  named: readonly (readonly [string, ArrayBufferView | string | null | undefined])[],
): { total: string; parts: Record<string, string> } {
  const parts: Record<string, string> = {};
  for (const [name, part] of named) parts[name] = hashPart(part);
  return {
    total: hashPart(named.map(([name]) => `${name}=${parts[name]}`).join(";")),
    parts,
  };
}
