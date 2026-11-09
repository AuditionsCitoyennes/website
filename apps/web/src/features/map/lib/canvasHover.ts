// Which pointer may hover a territory on the map canvas (useMapPins). Pure: no
// Vue, no DOM. The panel's rows have the same gate (geo-nav's rowHover.ts); the
// layering keeps the two apart.

/** Whether the canvas `mousemove` may set the map's hover, given the
 *  `pointerType` of the pointer last seen on the canvas: a mouse previews (and
 *  so does a canvas that saw no pointer event yet, a script's MouseEvent);
 *  touch and pen do not. iOS follows a tap with compatibility mouse events and
 *  fires no click for a tap whose mousemove revealed content — here the
 *  tapped unit's pill (docs/ios-simulator.md, iOS's hover-first rule). */
export function mouseMoveHovers(lastPointerType: string | undefined): boolean {
  return !lastPointerType || lastPointerType === "mouse";
}

/** The canvas's state: the type of the pointer last seen on it (plain
 *  closure, nothing renders from it). */
export function canvasHoverGate() {
  let last: string | undefined;
  return {
    pointerSeen(type: string | undefined) {
      last = type;
    },
    mouseMoveHovers: () => mouseMoveHovers(last),
  };
}
