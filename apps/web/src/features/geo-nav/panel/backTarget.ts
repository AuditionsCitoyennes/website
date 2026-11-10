// The panel's back arrow (PanelBreadcrumb): one level up the trail — the
// crumb before the last. The trail ends at the open lieu when there is one
// (useScope's `breadcrumb`), so with a lieu open this is the lieu's own unit,
// otherwise the scope's parent; none at the root. Not the browser's history.

/** The unit the back arrow flies to, or null (the trail is the root alone). */
export function backTarget<T extends { id: string }>(trail: readonly T[]): T | null {
  return trail.length >= 2 ? trail[trail.length - 2] : null;
}
