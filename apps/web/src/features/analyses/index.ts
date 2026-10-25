// What the association heard, as words on the lids: the overlay drawing the
// analyses around the raised territory, the statistics behind them, the
// plates' content maths and the DEV switch. The content modules are exported
// name by name: they share helpers of their own (the counts' lines, the text
// wrapping, the slabs' near-edge growth) that are not the barrel's.
export { default as ScopeAnalysisOverlay } from "./overlay/ScopeAnalysisOverlay.vue";
export * from "./stats/scopeStats";
export { countsOf, emptyTextOf, fmtN, plural, shortName, type CountPart } from "./content/text";
export { THEME_COLORS, THEME_PASTELS } from "./content/themeColors";
export {
  RING_LABEL,
  RING_OVER_LABEL,
  RING_THICK,
  ringOf,
  type Ring,
  type RingOpts,
  type RingPart,
} from "./content/ring";
export { measureText, typePx, type Measure, type TypePx } from "./content/measure";
export { slabSizes, type SizeOpts, type SlabSizes } from "./content/slabSizes";
export {
  FRAME_MIN_COMPACT,
  FRAME_MIN_WIDE,
  edgeMargin,
  plateRoom,
  slabGap,
  type PlateRoom,
  type RoomOpts,
  type ScreenOpts,
} from "./content/plateRoom";
export * from "./devSwitch";
