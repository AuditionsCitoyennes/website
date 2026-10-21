import { computed, ref, type Ref } from "vue";
import type { LocNode } from "@/shared/ui/select/treeNode";
import { formatDateShort } from "@/shared/format/dates";
import { fold } from "./filters";

/**
 * The state behind the filters dialog (FiltersDialog): the values picked, the
 * chips that show them, and the ways to take them off — the same on every page
 * that offers those filters. What they are applied to is the page's business.
 */
export function useFilters(locationTree: Ref<LocNode[]>) {
  const text = ref("");
  const topics = ref<string[]>([]);
  const locations = ref<string[]>([]);
  const dateFrom = ref<string | null>(null);
  const dateTo = ref<string | null>(null);
  const verified = ref(false);
  const sort = ref<"recent" | "ancien">("recent");

  /** The free text, folded for an accent- and case-insensitive search. */
  const needle = computed(() => fold(text.value.trim()));

  const locationLabel = computed(() => {
    const byToken = new Map<string, string>();
    const walk = (nodes: LocNode[]) => {
      for (const n of nodes) {
        byToken.set(n.token, n.label);
        if (n.children) walk(n.children);
      }
    };
    walk(locationTree.value);
    return byToken;
  });

  // One chip per filter on (the order is not one: it filters nothing out).
  const chips = computed(() => {
    const out: { id: string; label: string }[] = [];
    if (verified.value) out.push({ id: "verified", label: "Vérifiés uniquement" });
    for (const token of locations.value) {
      out.push({ id: `loc:${token}`, label: locationLabel.value.get(token) ?? token });
    }
    if (dateFrom.value)
      out.push({ id: "dateFrom", label: `Depuis ${formatDateShort(dateFrom.value)}` });
    if (dateTo.value)
      out.push({ id: "dateTo", label: `Jusqu'au ${formatDateShort(dateTo.value)}` });
    for (const t of topics.value) out.push({ id: `topic:${t}`, label: t });
    if (text.value.trim()) out.push({ id: "text", label: `« ${text.value.trim()} »` });
    return out;
  });

  function removeChip(id: string) {
    if (id === "verified") verified.value = false;
    else if (id === "dateFrom") dateFrom.value = null;
    else if (id === "dateTo") dateTo.value = null;
    else if (id === "text") text.value = "";
    else if (id.startsWith("loc:")) {
      const token = id.slice(4);
      locations.value = locations.value.filter((l) => l !== token);
    } else if (id.startsWith("topic:")) {
      const topic = id.slice(6);
      topics.value = topics.value.filter((t) => t !== topic);
    }
  }

  function reset() {
    text.value = "";
    topics.value = [];
    locations.value = [];
    dateFrom.value = null;
    dateTo.value = null;
    verified.value = false;
  }

  return {
    text,
    topics,
    locations,
    dateFrom,
    dateTo,
    verified,
    sort,
    needle,
    chips,
    removeChip,
    reset,
  };
}
