// The place picker's tree from the server's units (map phase 1, design E2,
// step 8): every audition on the map (empty=1), as buildLocationTree builds it
// from the map's groups — région > département > ville > lieu, weighted by
// testimonies, the heaviest first — its tokens unit and lieu ids (D2). A
// country level only when there is more than one country. The arrondissements
// of Paris, Lyon and Marseille are flattened into their commune, as today,
// unless asked for ("Arbre des lieux", a DEV switch).

import type { PlaceLieuRow, PlaceUnitRow } from "@ac/shared";
import type { LocNode } from "@/shared/ui/select/treeNode";

/** What the server's store holds of the tree (structurally geo's UnitTreeData). */
export interface PlaceTreeData {
  units: ReadonlyMap<
    string,
    {
      row: PlaceUnitRow | null;
      childIds?: readonly string[];
      lieuIds?: readonly string[];
    }
  >;
  lieux: ReadonlyMap<string, PlaceLieuRow>;
}

type Ordered = { id: string; n: number; rank: string; tie: string };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The server's order: testimonies desc, rank desc, tie, id (design A18). */
const byOrder = (a: Ordered, b: Ordered) =>
  b.n - a.n || cmp(b.rank, a.rank) || cmp(a.tie, b.tie) || cmp(a.id, b.id);

/** The picker's tree; `arrondissements`: keep them as a level of their own. */
export function buildPlaceTree(
  data: PlaceTreeData,
  opts: { arrondissements: boolean } = { arrondissements: false },
): LocNode[] {
  const rowOf = (id: string) => data.units.get(id)?.row ?? null;
  const isArr = (row: PlaceUnitRow) =>
    row.level === "locality" && rowOf(row.parent ?? "")?.level === "locality";

  /** A unit's child units and lieux (an arrondissement's, flattened, among
   *  its commune's own lieux). */
  function childrenOf(id: string, flatten: boolean): (Ordered & { lieu?: PlaceLieuRow })[] {
    const entry = data.units.get(id);
    const out: (Ordered & { lieu?: PlaceLieuRow })[] = [];
    for (const lid of entry?.lieuIds ?? []) {
      const lieu = data.lieux.get(lid);
      if (lieu) out.push({ id: lid, n: lieu.n, rank: lieu.rank, tie: lieu.tie, lieu });
    }
    for (const cid of entry?.childIds ?? []) {
      const row = rowOf(cid);
      if (!row) continue;
      if (flatten && isArr(row)) out.push(...childrenOf(cid, true).filter((c) => c.lieu));
      else out.push({ id: cid, n: row.n, rank: row.rank, tie: row.tie });
    }
    return out.sort(byOrder);
  }

  function nodeOf(item: Ordered & { lieu?: PlaceLieuRow }): LocNode {
    if (item.lieu) return { token: item.id, label: item.lieu.key, count: item.lieu.n };
    const row = rowOf(item.id)!;
    const kids = childrenOf(item.id, !opts.arrondissements);
    return {
      token: row.id,
      label: row.name,
      // A département's code beside its name, as the picker searches it.
      hint: row.level === "county" ? (row.code ?? undefined) : undefined,
      count: row.n,
      children: kids.length ? kids.map(nodeOf) : undefined,
    };
  }

  const countries = childrenOf("world", false).filter((c) => !c.lieu);
  // One country: its régions are the roots (and a lieu placed at no région
  // is left out, as the corpus' tree leaves it).
  const roots =
    countries.length === 1 ? childrenOf(countries[0].id, false).filter((c) => !c.lieu) : countries;
  return roots.map(nodeOf);
}
