import type { PlateauFrame } from "@/features/map/types";

/** What the overlay needs of the map: GeoDrillMap's exposed frame bus. */
export interface FrameSource {
  onFrame(cb: (f: PlateauFrame) => void): () => void;
  /** A wheel turned over the words, passed on to the map as its own. */
  forwardWheel(e: WheelEvent): void;
  /** The ring's part picked and the one hovered on unit `scopeId`'s: the
   *  parts raised and the bar follow. */
  setRing(scopeId: string, picked: string | null, hovered: string | null): void;
}
