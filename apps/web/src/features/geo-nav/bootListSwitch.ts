// What the Témoignages page's boot curtain covers while the map gets ready:
// the map's box only. It sits under the panel (the side panel on a desktop,
// the bottom sheet on a phone), which is held out of sight meanwhile by
// default (panelBoot.ts: only the loading placeholder shows, and the panel
// comes in as the curtain leaves); under the DEV switch's « Tout de suite »
// the list of places is usable over it as soon as its rows are in, while the
// map behind it finishes its first paint. It lifts by GeoNav's `booting`
// rule. Under it the map is inert (no focus stop hidden behind the curtain).
// A row chosen before the map is ready moves the panel at once; the camera
// command it gives is a prop of the map, which the map plays at its load.
//
// The home page's card (GeoNav `preview`) has no panel to show: it keeps the
// whole curtain, over the map and the panel alike.

/** What the boot curtain covers: the map's box alone (the panel usable over
 *  it), or the whole card (a card has no panel). */
export function bootCurtainCover(preview: boolean): "map" | "all" {
  return preview ? "all" : "map";
}
