import { ref, type Ref } from "vue";
import type { Testimony } from "@ac/shared";
import { api, ApiError } from "@/shared/api/client";
import { useToast } from "@/shared/ui/toast/useToast";
import type { AdminAudition } from "./useAdminAuditions";

/**
 * The "missing analyses" runners: every testimony without topics is sent to
 * /analyze, ONE AT A TIME — in the audition of the popup, or across every
 * audition of the site (super admin). Sequential on purpose: the API
 * rate-limits the analyses, and a testimony it refuses (a 429, say) is left
 * for next time while the batch goes on; only a configuration error stops it.
 *
 * `testimonies` are the popup's, `selectedAudition` the audition they belong
 * to; `fetchTestimonies` and `refreshFilterable` show the new topics.
 */
export function useTopicAnalysis({
  auditions,
  selectedAudition,
  testimonies,
  fetchTestimonies,
  refreshFilterable,
}: {
  auditions: Ref<AdminAudition[]>;
  selectedAudition: Ref<string | null>;
  testimonies: Ref<Testimony[]>;
  fetchTestimonies: (auditionId: string) => Promise<void>;
  refreshFilterable: () => void;
}) {
  const { toast } = useToast();

  const analyzingAll = ref(false);
  const analyzingMultiple = ref(false);

  async function analyzeMissing(list: Testimony[]): Promise<number> {
    let analyzed = 0;
    for (const t of list.filter((x) => !x.topics || x.topics.length === 0)) {
      try {
        const { topics } = await api.post<{ topics: string[] }>(`/api/testimonies/${t.id}/analyze`);
        if (topics.length > 0) analyzed++;
      } catch (e) {
        // Stop the batch on a configuration error (no API key) — every
        // subsequent call would fail the same way.
        if (e instanceof ApiError && e.status === 503) throw e;
      }
    }
    return analyzed;
  }

  // Analyze every testimony missing topics in the audition of the popup.
  async function handleAnalyzeSelected() {
    const auditionId = selectedAudition.value;
    if (!auditionId) return;
    const missing = testimonies.value.filter((t) => !t.topics || t.topics.length === 0);
    if (missing.length === 0) {
      toast({ title: "Info", description: "Tous les témoignages ont déjà été analysés" });
      return;
    }
    analyzingAll.value = true;
    try {
      const analyzed = await analyzeMissing(testimonies.value);
      // The user may have closed it, or opened another one, during the batch.
      if (selectedAudition.value === auditionId) await fetchTestimonies(auditionId);
      refreshFilterable();
      toast({ title: "Analyse terminée", description: `${analyzed} témoignage(s) analysé(s)` });
    } catch (e) {
      toast({
        title: "Erreur d'analyse",
        description: e instanceof ApiError ? e.message : "Une erreur est survenue",
        variant: "destructive",
      });
    } finally {
      analyzingAll.value = false;
    }
  }

  // Analyze every testimony missing topics across all auditions (super admin).
  async function handleAnalyzeAllAuditions() {
    analyzingMultiple.value = true;
    let totalAnalyzed = 0;
    let totalAuditions = 0;
    try {
      for (const audition of auditions.value) {
        const list = await api.get<Testimony[]>(
          `/api/testimonies/for-audition/${audition.id}`,
          true,
        );
        const missing = list.filter((t) => !t.topics || t.topics.length === 0);
        if (missing.length === 0) continue;
        totalAuditions++;
        totalAnalyzed += await analyzeMissing(list);
      }
      if (selectedAudition.value) await fetchTestimonies(selectedAudition.value);
      refreshFilterable();
      toast({
        title: "Analyse groupée terminée",
        description: `${totalAnalyzed} témoignage(s) analysé(s) sur ${totalAuditions} audition(s)`,
      });
    } catch (e) {
      toast({
        title: "Erreur d'analyse",
        description: e instanceof ApiError ? e.message : "Une erreur est survenue",
        variant: "destructive",
      });
    } finally {
      analyzingMultiple.value = false;
    }
  }

  return { analyzingAll, analyzingMultiple, handleAnalyzeSelected, handleAnalyzeAllAuditions };
}
