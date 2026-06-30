import { reactive } from "vue";

export interface Toast {
  id: number;
  title: string;
  description?: string;
  variant: "default" | "destructive";
}

const toasts = reactive<Toast[]>([]);
let nextId = 1;

const DISMISS_AFTER_MS = 5000;

export function useToast() {
  function toast(input: {
    title: string;
    description?: string;
    variant?: "default" | "destructive";
  }) {
    const t: Toast = {
      id: nextId++,
      title: input.title,
      description: input.description,
      variant: input.variant ?? "default",
    };
    toasts.push(t);
    setTimeout(() => dismiss(t.id), DISMISS_AFTER_MS);
  }

  function dismiss(id: number) {
    const i = toasts.findIndex((t) => t.id === id);
    if (i !== -1) toasts.splice(i, 1);
  }

  return { toasts, toast, dismiss };
}
