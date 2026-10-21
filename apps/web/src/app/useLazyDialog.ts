import { defineAsyncComponent, ref, watch, type AsyncComponentLoader, type Ref } from "vue";
import { useToast } from "@/shared/ui/toast/useToast";

/**
 * A site-wide popup downloaded only once it is first mounted. If it cannot be
 * downloaded (connection lost, or a tab older than the last deployment), the
 * buttons that open it must not simply do nothing: it is tried again, then
 * said — and the popup closed again, so a later press says it again.
 *
 * `loader` stays a literal `() => import("…")` in the caller: that is what
 * Vite splits into a chunk of its own.
 */
export function useLazyDialog(options: {
  loader: AsyncComponentLoader;
  /** The popup's open flag (a module-level singleton: useCreateAudition, …). */
  open: Ref<boolean>;
  hide: () => void;
}) {
  const { toast } = useToast();
  const unavailable = ref(false);
  const component = defineAsyncComponent({
    loader: options.loader,
    onError(_error, retry, fail, attempts) {
      if (attempts <= 2) return retry();
      unavailable.value = true;
      fail();
    },
  });
  // A press after the failure — or one made while it was still loading.
  watch([unavailable, options.open], ([isUnavailable, isOpen]) => {
    if (!isUnavailable || !isOpen) return;
    options.hide();
    toast({
      title: "Formulaire indisponible",
      description: "Le formulaire n'a pas pu être chargé. Rechargez la page.",
      variant: "destructive",
    });
  });
  return { component, unavailable };
}
