/** A node of the location tree LocationMultiSelect offers: an area or a place,
 *  with the places under it. */
export interface LocNode {
  token: string;
  label: string;
  hint?: string;
  count?: number;
  children?: LocNode[];
}
