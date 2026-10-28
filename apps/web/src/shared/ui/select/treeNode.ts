/** A node of the location tree LocationMultiSelect offers: an area or a place,
 *  with the places under it. */
export interface LocNode {
  token: string;
  label: string;
  hint?: string;
  count?: number;
  children?: LocNode[];
  /** Its children are not known yet (a tree read as it is opened): "idle"
   *  until asked for — LocationMultiSelect's loadChildren, when it is opened —,
   *  then "loading", or "failed" (opened again: asked again). */
  lazy?: "idle" | "loading" | "failed";
}
