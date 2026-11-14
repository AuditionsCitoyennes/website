// When the lid's hidden map (mapSnapshot.ts: a second Mapbox map, drawn off
// screen, whose picture is the plateau's top) is created, and whether it is
// at all (`ac:lid-map`, the Témoignages page's DEV dialog, « Carte cachée »):
//
// - "boot": at the visible map's load, on Mapbox's default view (the whole
//   world, zoom 0) and small (512 px): its style, its shaders and its share
//   of the tile workers are paid then, and so are the world tiles of that
//   view, which no lid shows.
// - "first-place": for the first place a plateau will stand on. At the
//   visible map's load when that place is known by then (the scope's outline,
//   else the rectangle the first camera command frames): the hidden map is
//   created on the place's rectangle at the size of a select's shot, so the
//   only tiles it asks for are the first lid's. With no place known at the
//   load (the world level, a scope without a boundary), no hidden map until
//   the first shot, which creates it on its own rectangle.
// - "none": no hidden map and no lid. The plateau keeps its wall, its lines,
//   its halo, the grey outside and its rise; its top is the live map, as it
//   is today before a lid lands: draped at the plateau's height on raised
//   ground, seen at ground level inside the wall on flat ground
//   (relief/groundSwitch.ts).
// - "auto" (the default): "none" on a device whose tier is "minimal"
//   (shared/device/deviceTier), "first-place" on every other.
//
// The choice is read once per page load (switching reloads: the hidden map is
// created at the visible map's load). Under "auto" the device's tier is read
// at the load and again at each selection: a tier that falls to "minimal"
// during the visit (the first flight's frames) leaves the standing plateau its
// lid, and the next selection has none — the hidden map is removed then.
// `ac:lid` (lidSwitch.ts) comes first: "aucun" is "none" whatever this says,
// and "ancien", the lid as before, is always created as in "boot" unless this
// says "none". Production has neither key nor switch: DEFAULT_LID_MAP.
//
// No import and nothing run at load but the switch's read: loadable under
// node (lidMapSwitch.test.ts).

export type LidMap = "auto" | "boot" | "first-place" | "none";
/** When the hidden map is created, once decided. */
export type LidMapPlan = Exclude<LidMap, "auto">;

/** The choice of a build without the testing tools, and the switch's default. */
export const DEFAULT_LID_MAP: LidMap = "auto";

export const LID_MAPS: readonly LidMap[] = ["auto", "boot", "first-place", "none"];

/** The kept choice, else the default (garbage or blocked storage too). */
export function storedLidMap(): LidMap {
  try {
    const raw = localStorage.getItem("ac:lid-map");
    return (LID_MAPS as readonly string[]).includes(raw ?? "") ? (raw as LidMap) : DEFAULT_LID_MAP;
  } catch {
    return DEFAULT_LID_MAP;
  }
}

/** This page load's choice. */
export const lidMap: LidMap = __TEST_TOOLS__ ? storedLidMap() : DEFAULT_LID_MAP;

/** Another choice: kept, and the page loaded again with it. */
export function setLidMap(choice: LidMap) {
  if (!__TEST_TOOLS__ || choice === lidMap) return;
  try {
    localStorage.setItem("ac:lid-map", choice);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
  window.location.reload();
}

/** The plan of a choice on a device of this tier, under this lid mode
 *  (`ac:lid`: "ecran", "ancien" or "aucun"). */
export function lidMapFor(
  choice: LidMap,
  tier: "full" | "light" | "minimal",
  lidMode: "ecran" | "ancien" | "aucun" = "ecran",
): LidMapPlan {
  if (lidMode === "aucun") return "none";
  const plan = choice === "auto" ? (tier === "minimal" ? "none" : "first-place") : choice;
  if (plan === "none") return "none";
  return lidMode === "ancien" ? "boot" : plan;
}

/** A rectangle, in degrees (the geo feature's Bounds, mapSnapshot's SnapshotBounds). */
export interface PlaceBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** A rectangle a map can be created on: finite, not empty, within the
 *  latitudes mercator draws. */
export function usablePlace(b: PlaceBounds | null | undefined): b is PlaceBounds {
  if (!b) return false;
  const all = [b.minLat, b.maxLat, b.minLng, b.maxLng];
  if (!all.every((v) => Number.isFinite(v))) return false;
  return b.minLat < b.maxLat && b.minLng < b.maxLng && b.minLat >= -90 && b.maxLat <= 90;
}

/** What the visible map's load does about the hidden map: nothing (`null`),
 *  or create it — on the world (`place: null`, "boot") or on the first place.
 *  `outline`: the rectangle of the scope's outline, when it is in by then;
 *  `framed`: the rectangle the first camera command frames. */
export function warmupAtLoad(
  plan: LidMapPlan,
  outline: PlaceBounds | null | undefined,
  framed: PlaceBounds | null | undefined,
): { place: PlaceBounds | null } | null {
  if (plan === "none") return null;
  if (plan === "boot") return { place: null };
  const place = usablePlace(outline) ? outline : usablePlace(framed) ? framed : null;
  return place ? { place } : null;
}

/** Mapbox's tile size, css px: the world is this wide at zoom 0. */
const WORLD_CSS = 512;
const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin((Math.max(-85.051129, Math.min(85.051129, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/** The camera of a top-down mercator map, `cssPx` wide and high, that frames
 *  `place` with `paddingCss` px left free on each side: what Mapbox's
 *  cameraForBounds answers for it (no pitch, no bearing), computed here so
 *  that a map can be created on it. Mapbox's own way to create a map on a
 *  rectangle with a margin (`bounds` and `fitBoundsOptions.padding`) keeps
 *  the margin as the map's padding from then on, and a padded map reports
 *  bounds smaller than its canvas — which a lid shot reads as what its
 *  picture covers. */
export function cameraOver(
  place: PlaceBounds,
  cssPx: number,
  paddingCss: number,
): { center: [number, number]; zoom: number } {
  const x0 = mercX(place.minLng);
  const x1 = mercX(place.maxLng);
  const y0 = mercY(place.maxLat); // north: the smaller y
  const y1 = mercY(place.minLat);
  const room = Math.max(1, cssPx - 2 * paddingCss);
  const span = Math.max(x1 - x0, y1 - y0, 1e-12);
  const zoom = Math.max(0, Math.min(22, Math.log2(room / (WORLD_CSS * span))));
  const midY = (y0 + y1) / 2;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * midY))) * 180) / Math.PI;
  return { center: [((x0 + x1) / 2) * 360 - 180, lat], zoom };
}
