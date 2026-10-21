// The site header as the map pages measure it (AppHeader.vue draws it): on a
// wide screen the map sits under the header's box; on a phone the header
// floats over the page and only its tiles reach down over the map.

/** The header's element — `header.header` in AppHeader.vue. */
export const HEADER_SELECTOR = "header.header";

/** A phone: the header floats over the page instead of taking room above it. */
export function isPhone(): boolean {
  return window.matchMedia("(max-width: 899px)").matches;
}

/** The header box's bottom edge, px from the top of the viewport; 0 without a
 *  header. */
export function headerBottomPx(): number {
  const header = document.querySelector<HTMLElement>(HEADER_SELECTOR);
  return Math.max(0, Math.round(header?.getBoundingClientRect().bottom ?? 0));
}

/** How far down the header's floating tiles reach: the lowest tile's bottom
 *  edge, px from the top of the viewport. None found (the header laid out
 *  otherwise): its whole box, to be safe. Null without a header. */
export function headerTilesBottomPx(): number | null {
  const header = document.querySelector<HTMLElement>(HEADER_SELECTOR);
  if (!header) return null;
  const tiles = [...header.querySelectorAll(".header-inner > *")]
    .map((tile) => tile.getBoundingClientRect())
    .filter((r) => r.height > 0);
  return tiles.length
    ? Math.max(...tiles.map((r) => r.bottom))
    : header.getBoundingClientRect().bottom;
}
