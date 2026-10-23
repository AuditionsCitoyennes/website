/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  readonly VITE_API_URL: string;
  /** The site's environment: "staging" builds the test outbox in (vite.config's __OUTBOX__). */
  readonly VITE_APP_ENV?: "local" | "staging" | "production";
  readonly VITE_MAPBOX_TOKEN?: string;
  readonly VITE_MAPBOX_STYLE?: string;
}

/** Whether this build has the test outbox (see vite.config). */
declare const __OUTBOX__: boolean;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
