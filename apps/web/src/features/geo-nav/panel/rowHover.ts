// Which pointer may hover a unit row (UnitList). Pure: no Vue, no DOM.

/** Whether a unit row's `mouseenter` may hand the map its hover, given the
 *  `pointerType` of the pointer that last entered a row: a mouse previews (and
 *  so does an event that names none: nothing seen yet, a script's MouseEvent);
 *  touch and pen do not. iOS follows a tap with compatibility mouse events and
 *  fires no click for a tap whose mouseover revealed content — here the
 *  unit's pill on the map (docs/ios-simulator.md, iOS's hover-first rule). */
export function mouseEnterHovers(lastPointerType: string | undefined): boolean {
  return !lastPointerType || lastPointerType === "mouse";
}

/** The per-list state the rows share: the type of the pointer that last
 *  entered a row (plain closure, nothing renders from it). */
export function rowHoverGate() {
  let last: string | undefined;
  return {
    pointerEnter(type: string | undefined) {
      last = type;
    },
    mouseEnterHovers: () => mouseEnterHovers(last),
  };
}
