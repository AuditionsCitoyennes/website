// The place picker's tree from the server's units (map phase 1, design E2,
// step 8): every audition on the map (empty=1), as buildLocationTree builds it
// from the map's groups — région > département > ville > lieu, weighted by
// testimonies, the heaviest first — its tokens unit and lieu ids (D2). A
// country level only when there is more than one country. The arrondissements
// of Paris, Lyon and Marseille are flattened into their commune, as today,
// unless asked for ("Arbre des lieux", a DEV switch); an overseas territory is
// one level, its région (@ac/shared frOverseas). On the lazy path (a
// tree too big for one answer) a unit whose children are not all known yet is
// `lazy`, with no children: the picker asks for them when it is opened.

import { foldedDepartementOf, type PlaceLieuRow, type PlaceUnitRow } from "@ac/shared";
import type { LocNode } from "@/shared/ui/select/treeNode";

/** What the server's store holds of the tree (structurally geo's UnitTreeData). */
export interface PlaceTreeData {
  units: ReadonlyMap<
    string,
    {
      row: PlaceUnitRow | null;
      childIds?: readonly string[];
      lieuIds?: readonly string[];
      /** Its children and lieux are known. */
      loaded: boolean;
    }
  >;
  lieux: ReadonlyMap<string, PlaceLieuRow>;
}

export interface PlaceTreeOptions {
  /** Keep the arrondissements as a level of their own. */
  arrondissements: boolean;
  /** Where a unit's children stand when not known yet (on their way, or
   *  failed); idle when not given or not asked for. */
  statusOf?: (id: string) => "loading" | "failed" | null;
}

type Ordered = { id: string; n: number; rank: string; tie: string };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The server's order: testimonies desc, rank desc, tie, id (design A18). */
const byOrder = (a: Ordered, b: Ordered) =>
  b.n - a.n || cmp(b.rank, a.rank) || cmp(a.tie, b.tie) || cmp(a.id, b.id);

/** The picker's tree. */
export function buildPlaceTree(
  data: PlaceTreeData,
  opts: PlaceTreeOptions = { arrondissements: false },
): LocNode[] {
  const rowOf = (id: string) => data.units.get(id)?.row ?? null;
  const isArr = (row: PlaceUnitRow) =>
    row.level === "locality" && rowOf(row.parent ?? "")?.level === "locality";
  /** The département a loaded overseas région holds as its own level (one
   *  territory, @ac/shared frOverseas), or null. */
  const foldedOf = (id: string): string | null => {
    const row = rowOf(id);
    const entry = data.units.get(id);
    if (row?.level !== "region" || !entry?.loaded) return null;
    return foldedDepartementOf(
      row.name,
      (entry.childIds ?? []).flatMap((cid) => {
        const r = rowOf(cid);
        return r ? [{ id: cid, name: r.name, isDepartement: r.level === "county" }] : [];
      }),
    );
  };

  /** A unit's child units and lieux (an arrondissement's, flattened, among
   *  its commune's own lieux; a folded département's, among its région's). */
  function childrenOf(id: string, flatten: boolean): (Ordered & { lieu?: PlaceLieuRow })[] {
    const entry = data.units.get(id);
    const out: (Ordered & { lieu?: PlaceLieuRow })[] = [];
    for (const lid of entry?.lieuIds ?? []) {
      const lieu = data.lieux.get(lid);
      if (lieu) out.push({ id: lid, n: lieu.n, rank: lieu.rank, tie: lieu.tie, lieu });
    }
    const folded = foldedOf(id);
    for (const cid of entry?.childIds ?? []) {
      const row = rowOf(cid);
      if (!row) continue;
      if (cid === folded) out.push(...childrenOf(cid, flatten));
      else if (flatten && isArr(row)) out.push(...childrenOf(cid, true).filter((c) => c.lieu));
      else out.push({ id: cid, n: row.n, rank: row.rank, tie: row.tie });
    }
    return out.sort(byOrder);
  }

  /** Whether a unit's children are all known: it is loaded, and so are its
   *  folded département and the arrondissements flattened into it. */
  function known(id: string, flatten: boolean): boolean {
    const entry = data.units.get(id);
    if (!entry?.loaded) return false;
    const folded = foldedOf(id);
    if (folded && !known(folded, flatten)) return false;
    if (!flatten) return true;
    return (entry.childIds ?? []).every((cid) => {
      const row = rowOf(cid);
      return !row || !isArr(row) || known(cid, true);
    });
  }

  function nodeOf(item: Ordered & { lieu?: PlaceLieuRow }): LocNode {
    if (item.lieu) return { token: item.id, label: item.lieu.key, count: item.lieu.n };
    const row = rowOf(item.id)!;
    const flatten = !opts.arrondissements;
    const node: LocNode = {
      token: row.id,
      label: row.name,
      // A département's code beside its name, as the picker searches it.
      hint: row.level === "county" ? (row.code ?? undefined) : undefined,
      count: row.n,
    };
    if (!known(item.id, flatten)) {
      node.lazy = opts.statusOf?.(item.id) ?? "idle";
      return node;
    }
    const kids = childrenOf(item.id, flatten);
    if (kids.length) node.children = kids.map(nodeOf);
    return node;
  }

  const countries = childrenOf("world", false).filter((c) => !c.lieu);
  // One country: its régions are the roots (and a lieu placed at no région
  // is left out, as the corpus' tree leaves it).
  const roots =
    countries.length === 1 ? childrenOf(countries[0].id, false).filter((c) => !c.lieu) : countries;
  return roots.map(nodeOf);
}
