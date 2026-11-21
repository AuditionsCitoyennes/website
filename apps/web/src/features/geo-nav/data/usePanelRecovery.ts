// The map page comes back by itself after a network failure
// (shared/net/recoverSwitch.ts): what the panel could not have — the
// tree of places, the results, a lieu's auditions — is asked again after the
// recovery waits (2, 5, 10, 20, 30 s), then whenever the browser is back
// online or the page shown again, and at once on the panel's « Réessayer ».
// Meanwhile the panel says what is happening (`offline`: the browser says it
// has no network).

import { onScopeDispose, ref, watch, type Ref } from "vue";
import { browserOffline, onReconnect } from "@/shared/net/reconnect";
import { recoverDelay } from "@/shared/net/recoverSwitch";
import { retrySchedule, type RetryState } from "@/shared/net/retrySchedule";

export interface PanelRecovery {
  /** The browser says it has no network. */
  offline: Ref<boolean>;
  /** The panel's « Réessayer ». */
  retryNow: () => void;
}

export function usePanelRecovery(o: { state: () => RetryState; retry: () => void }): PanelRecovery {
  const offline = ref(false);

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
  return { offline, retryNow: () => schedule.now() };
}
