/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  readonly VITE_API_URL: string;
  /** The site's environment: "staging" builds the testing tools in (vite.config's __TEST_TOOLS__). */
  readonly VITE_APP_ENV?: "local" | "staging" | "production";
  readonly VITE_MAPBOX_TOKEN?: string;
  readonly VITE_MAPBOX_STYLE?: string;
  /** Where the static map data is served (the outline files): unset = same origin `/map-data/`. */
  readonly VITE_MAP_DATA_BASE?: string;
  /** "on" builds the Analyses in (vite.config's __ANALYSES__): staging; unset in production. */
  readonly VITE_ANALYSES?: "on";
  /** How a build sends its content security policy (vite.config, shared/boot/csp.ts): unset
   *  applies it; "report-only" only reports what it would block, in the browser's console. */
  readonly VITE_CSP?: "report-only";
  /** Cloudflare Turnstile's site key: set, the forms show the challenge and the content
   *  security policy allows its script and frame; unset, neither. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

/** Whether this build has the testing tools: the outbox, the DEV switches (see vite.config). */
declare const __TEST_TOOLS__: boolean;
/** Whether this build has the Analyses: the toggle, the plates, the slabs (see vite.config). */
declare const __ANALYSES__: boolean;
/** The outline build the site reads: apps/web/outlines.lock.json's (see vite.config). */
declare const __OUTLINES_BUILD__: string;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
