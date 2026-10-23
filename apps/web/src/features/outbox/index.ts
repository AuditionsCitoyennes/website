// The test outbox (staging and local development only): the button and the
// dialog that show the emails the API kept instead of sending them. A loader:
// the shell mounts it only in a build that has it (__OUTBOX__, see
// vite.config), so any other build carries none of it.
export const loadOutboxLauncher = () => import("./OutboxLauncher.vue");
