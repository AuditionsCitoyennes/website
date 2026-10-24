import { computed, ref, watch, type Ref } from "vue";
import type { Testimony } from "@ac/shared";
import { api, ApiError } from "@/shared/api/client";
import { useToast } from "@/shared/ui/toast/useToast";
import { placementNote } from "./placement";
import type { AdminAudition } from "./useAdminAuditions";

/**
 * The audition's popup: which audition is open (its line or its eye button
 * was clicked), its testimonies shown in there, the edit form opened from it,
 * and what its buttons do — delete it, or hear that its testimonies changed.
 *
 * `reachableAuditions`: what may be opened. `fetchAuditions` and
 * `refreshFilterable` are the list's own refreshes, called when something done
 * in the popup changes what the list shows.
 */
export function useAuditionPopup(
  reachableAuditions: Ref<AdminAudition[]>,
  {
    fetchAuditions,
    refreshFilterable,
  }: { fetchAuditions: () => Promise<void>; refreshFilterable: () => void },
) {
  const { toast } = useToast();

  // The audition whose popup is open (its line or its eye button was clicked),
  // and its testimonies, shown in there.
  const selectedAudition = ref<string | null>(null);
  const testimonies = ref<Testimony[]>([]);
  // Until the first answer for this audition: not to be read as "it has none".
  const loadingTestimonies = ref(false);
  /** The audition whose edit form is open (AuditionEditDialog): only ever from the popup. */
  const editing = ref<AdminAudition | null>(null);

  const openAudition = computed(
    () => reachableAuditions.value.find((a) => a.id === selectedAudition.value) ?? null,
  );
  const openNote = computed(() => placementNote(openAudition.value?.area));

  /** The popup changed this audition's testimonies (added, edited, removed…). */
  async function onTestimoniesChanged(auditionId: string) {
    refreshFilterable();
    await fetchTestimonies(auditionId);
    // None left: the audition may have gone with its last one, deleted from
    // elsewhere meanwhile (a witness's link, another admin) — the list says
    // whether it is still there, and the popup closes if not.
    if (selectedAudition.value === auditionId && testimonies.value.length === 0) {
      await fetchAuditions();
    }
  }

  /** Its last testimony deleted, the audition went with it: out of the list. */
  async function onAuditionEmptied(auditionId: string) {
    if (selectedAudition.value === auditionId) closePopup();
    refreshFilterable();
    await fetchAuditions();
  }

  async function fetchTestimonies(auditionId: string) {
    try {
      const rows = await api.get<Testimony[]>(`/api/testimonies/for-audition/${auditionId}`, true);
      // Drop responses that no longer match the expanded audition (the user
      // switched or collapsed while the request was in flight).
      if (selectedAudition.value !== auditionId) return;
      testimonies.value = rows;
    } catch {
      if (selectedAudition.value === auditionId) testimonies.value = [];
    }
  }

  // The popup opens with the audition's testimonies in it.
  async function openPopup(id: string) {
    selectedAudition.value = id;
    testimonies.value = []; // never show the previous audition's rows
    loadingTestimonies.value = true;
    await fetchTestimonies(id);
    // Unless another audition was opened meanwhile (its own load is running).
    if (selectedAudition.value === id) loadingTestimonies.value = false;
  }

  /** A click anywhere on the line opens it too — unless it ends a text
   *  selection (copying a title out of the list must stay possible). */
  function onLineClick(id: string) {
    if (window.getSelection()?.toString()) return;
    openPopup(id);
  }

  function closePopup() {
    selectedAudition.value = null;
    testimonies.value = [];
    loadingTestimonies.value = false;
    // The edit form is only ever opened from the popup: it goes with it.
    editing.value = null;
  }

  // The audition left the list (deleted here or elsewhere): nothing to show, and
  // nothing left to edit.
  watch(openAudition, (audition) => {
    if (!audition && selectedAudition.value !== null) closePopup();
  });

  function startEditing(audition: AdminAudition) {
    editing.value = audition;
  }

  // While the deletion is on its way the popup's buttons are frozen: nothing
  // else is started on an audition that is about to disappear.
  const deleting = ref(false);

  async function handleDelete(id: string) {
    if (deleting.value) return;
    if (!confirm("Êtes-vous sûr de vouloir supprimer cette audition?")) return;
    deleting.value = true;
    try {
      await api.del(`/api/auditions/${id}`);
      toast({ title: "Succès!", description: "Audition supprimée" });
      if (selectedAudition.value === id) closePopup();
      await fetchAuditions();
    } catch (e) {
      toast({
        title: "Erreur",
        description: e instanceof ApiError ? e.message : "Une erreur est survenue",
        variant: "destructive",
      });
    } finally {
      deleting.value = false;
    }
  }

  return {
    selectedAudition,
    testimonies,
    loadingTestimonies,
    openAudition,
    openNote,
    fetchTestimonies,
    openPopup,
    onLineClick,
    closePopup,
    editing,
    startEditing,
    onTestimoniesChanged,
    onAuditionEmptied,
    deleting,
    handleDelete,
  };
}
