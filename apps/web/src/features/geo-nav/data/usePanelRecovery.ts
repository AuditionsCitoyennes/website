// The map page comes back by itself after a network failure (`ac:recover`
// "auto", shared/net/recoverSwitch.ts): what the panel could not have — the
// tree of places, the results, a lieu's auditions — is asked again after the
// recovery waits (2, 5, 10, 20, 30 s), then whenever the browser is back
// online or the page shown again, and at once on the panel's « Réessayer ».
// Meanwhile the panel says what is happening (`offline`: the browser says it
// has no network). Under "ancien" nothing is scheduled: what failed is asked
// again at the next move, as before.

import { onScopeDispose, ref, watch, type Ref } from "vue";
import { browserOffline, onReconnect } from "@/shared/net/reconnect";
import { recover, recoverDelay } from "@/shared/net/recoverSwitch";
import { retrySchedule, type RetryState } from "@/shared/net/retrySchedule";

export interface PanelRecovery {
  /** The recovery runs (the panel shows its sentences and its button). */
  on: boolean;
  /** The browser says it has no network. */
  offline: Ref<boolean>;
  /** The panel's « Réessayer ». */
  retryNow: () => void;
}

export function usePanelRecovery(o: { state: () => RetryState; retry: () => void }): PanelRecovery {
  const offline = ref(false);
  if (recover !== "auto") return { on: false, offline, retryNow: o.retry };

  const schedule = retrySchedule({
    retry: o.retry,
    delay: recoverDelay,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (timer) => window.clearTimeout(timer as number),
  });
  watch(o.state, (s) => schedule.update(s), { immediate: true });

  const net = () => (offline.value = browserOffline());
  net();
  window.addEventListener("online", net);
  window.addEventListener("offline", net);
  const stop = onReconnect(() => schedule.now());
  onScopeDispose(() => {
    stop();
    schedule.stop();
    window.removeEventListener("online", net);
    window.removeEventListener("offline", net);
  });
  return { on: true, offline, retryNow: () => schedule.now() };
}
