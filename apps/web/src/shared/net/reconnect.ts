// The moments the network may be back: the browser says it is online again,
// or the page is shown again (a phone's tab brought back, often on another
// network). A listener, not a loop: nothing runs between these events.
// The targets are injected (reconnect.test.ts).

interface Targets {
  win: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  doc: Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
    visibilityState: string;
  };
}

/** Calls `fn` at each such moment; returns the unsubscribe. */
export function onReconnect(
  fn: () => void,
  targets: Targets = { win: window, doc: document },
): () => void {
  const { win, doc } = targets;
  const online = () => fn();
  const visible = () => {
    if (doc.visibilityState === "visible") fn();
  };
  win.addEventListener("online", online);
  doc.addEventListener("visibilitychange", visible);
  return () => {
    win.removeEventListener("online", online);
    doc.removeEventListener("visibilitychange", visible);
  };
}

/** Whether the browser believes it has no network at all (navigator.onLine
 *  false); true only when it says so, never a guess. */
export function browserOffline(nav: { onLine?: boolean } = navigator): boolean {
  return nav.onLine === false;
}
