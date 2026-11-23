// What a click on a lieu's pin opens (pinOpen.ts), compared live (the
// Témoignages page's testing options menu, temoignages/DevOptionsMenu.vue) in
// the builds with the testing tools — the dev server and staging
// (__TEST_TOOLS__, vite.config): "premiere" (the default) — the top of the
// lieu's list, open — or "liste": the lieu's list (as before). Read at each
// click by useNavActions' openPlace, so a choice applies at once, with no
// reload. Production keeps the default, which this ref never leaves there (no
// switch is drawn).
import { ref } from "vue";
import { DEFAULT_PIN_OPEN, PIN_OPEN_MODES, type PinOpenMode } from "./pinOpen";

export type { PinOpenMode } from "./pinOpen";

const enabled = __TEST_TOOLS__;
const PIN_OPEN_KEY = "ac:pin-open";

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (!enabled) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

// Read only in the builds with the testing tools: production has neither the
// key nor the call.
export const pinOpenMode = ref<PinOpenMode>(
  __TEST_TOOLS__ ? stored(PIN_OPEN_KEY, PIN_OPEN_MODES, DEFAULT_PIN_OPEN) : DEFAULT_PIN_OPEN,
);

export function setPinOpenMode(m: PinOpenMode) {
  if (!enabled) return;
  pinOpenMode.value = m;
  try {
    localStorage.setItem(PIN_OPEN_KEY, m);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}
