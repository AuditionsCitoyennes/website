// The site's captcha (Cloudflare Turnstile), one loader for every form that
// asks for one: the sign-in, sign-up and password-recovery forms hand its
// token to Supabase Auth, the « Témoigner » form to the API.
//
// It exists only in a build made with VITE_TURNSTILE_SITE_KEY: without the
// key no script is loaded and every form sends as it always did. With it,
// Cloudflare's script is downloaded the first time a form is sent, and each
// sending gets its own token (a token is checked once, by whoever receives
// it). The widget stays out of sight unless Cloudflare wants the visitor to
// tick it.
//
// In a form:
//   const captcha = useCaptcha();
//   <CaptchaZone :captcha="captcha" />            (where the widget may show)
//   const proof = await captcha.proof(submit);    (in `submit`)
//   if (!proof) return;                           (the zone says why, and « Réessayer » runs `submit` again)
//   … send, with proof.token (undefined in a build without the key)

import { ref, type Ref } from "vue";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** How long a visitor may take over a challenge before the form gives up. */
const CHALLENGE_LIMIT_MS = 120_000;

/** What Cloudflare's script offers, as far as the site uses it. */
interface Turnstile {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      language: string;
      appearance: "interaction-only";
      "response-field": false;
      callback: (token: string) => void;
      "error-callback": () => boolean;
      "timeout-callback": () => void;
      "unsupported-callback": () => void;
    },
  ): string | undefined;
  remove(widget: string): void;
}

const siteKey = (): string | undefined => import.meta.env.VITE_TURNSTILE_SITE_KEY || undefined;

/** Whether this build asks for a captcha at all. */
export const captchaConfigured = (): boolean => siteKey() !== undefined;

/** The captcha could not be had: its script did not load (no network, a
 *  content blocker), or the challenge did not complete. */
export class CaptchaUnavailable extends Error {
  constructor() {
    super("The captcha could not be loaded or completed");
    this.name = "CaptchaUnavailable";
  }
}

/** What a form shows then, beside « Réessayer ». */
export const CAPTCHA_UNAVAILABLE_TEXT =
  "La vérification anti-robot n'a pas pu se charger. Vérifiez votre connexion, désactivez un éventuel bloqueur de contenu, puis réessayez.";

let script: Promise<Turnstile> | null = null;

/** Cloudflare's script, asked for once; a failed download is asked for again
 *  on the next call. */
function loadTurnstile(): Promise<Turnstile> {
  script ??= new Promise<Turnstile>((resolve, reject) => {
    const tag = document.createElement("script");
    const failed = () => {
      tag.remove();
      script = null;
      reject(new CaptchaUnavailable());
    };
    tag.src = SCRIPT_URL;
    tag.async = true;
    tag.onload = () => {
      const turnstile = (window as { turnstile?: Turnstile }).turnstile;
      if (turnstile) resolve(turnstile);
      else failed();
    };
    tag.onerror = failed;
    document.head.append(tag);
  });
  return script;
}

/** Where the widget shows when a form gives it no place of its own: over the
 *  page, at the bottom, above any dialog. */
function floatingHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:50%;bottom:1rem;transform:translateX(-50%);z-index:2147483000";
  document.body.append(host);
  return host;
}

/**
 * One captcha token, for one sending. `undefined` in a build without the key.
 * The widget is drawn in `host` (or over the page) for as long as the
 * challenge lasts. Throws CaptchaUnavailable when no token could be had.
 */
export async function captchaToken(host?: HTMLElement | null): Promise<string | undefined> {
  const sitekey = siteKey();
  if (!sitekey) return undefined;
  const turnstile = await loadTurnstile();
  const own = host ? null : floatingHost();
  const box = document.createElement("div");
  (host ?? own!).append(box);

  return new Promise<string>((resolve, reject) => {
    let widget: string | undefined;
    const end = () => {
      window.clearTimeout(limit);
      if (widget) turnstile.remove(widget);
      (own ?? box).remove();
    };
    const fail = () => {
      end();
      reject(new CaptchaUnavailable());
    };
    const limit = window.setTimeout(fail, CHALLENGE_LIMIT_MS);
    try {
      widget =
        turnstile.render(box, {
          sitekey,
          language: "fr",
          appearance: "interaction-only",
          "response-field": false,
          callback: (token) => {
            end();
            resolve(token);
          },
          // true: the failure is handled here, Cloudflare logs nothing more.
          "error-callback": () => {
            fail();
            return true;
          },
          "timeout-callback": fail,
          "unsupported-callback": fail,
        }) ?? undefined;
    } catch {
      fail();
    }
  });
}

/** A form's captcha: see the top of this file. */
export interface FormCaptcha {
  /** Where the widget shows (CaptchaZone binds it). */
  host: Ref<HTMLElement | null>;
  /** Whether the last sending stopped for want of a captcha. */
  unavailable: Ref<boolean>;
  /** The captcha for one sending: `{ token }` (the token undefined in a build
   *  without the key), or null when it could not be had. `again` is what
   *  « Réessayer » then runs. */
  proof(again: () => void): Promise<{ token: string | undefined } | null>;
  /** « Réessayer ». */
  retry(): void;
}

export function useCaptcha(): FormCaptcha {
  const host = ref<HTMLElement | null>(null);
  const unavailable = ref(false);
  let last: (() => void) | null = null;

  return {
    host,
    unavailable,
    async proof(again) {
      unavailable.value = false;
      try {
        return { token: await captchaToken(host.value) };
      } catch (error) {
        if (!(error instanceof CaptchaUnavailable)) throw error;
        last = again;
        unavailable.value = true;
        return null;
      }
    },
    retry() {
      unavailable.value = false;
      last?.();
    },
  };
}
