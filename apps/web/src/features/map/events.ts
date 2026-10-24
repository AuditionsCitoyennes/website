// The window events the map and the stage above it share.

/** Dispatched by MapStage once the map has been moved to another place in the
 *  page (the home page's card, the page, or lifted out over both): the map
 *  draws again at once — a moved canvas can show blank until its next frame. */
export const MAP_MOVED_EVENT = "ac:map-moved";
