import { clientIfSignedIn } from "./supabaseLazy";
import { outboxNudge, outboxViewer } from "./outbox";
import { readWithin } from "./readTimeout";

/** Where the API is: read when a request leaves, so that this module also
 *  loads under node (client.test.ts). */
const baseUrl = (): string => import.meta.env.VITE_API_URL ?? "http://localhost:3000";

interface ApiOptions extends RequestInit {
  /** Attach the current Supabase access token as a Bearer header. */
  auth?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** How long the server asked to wait before trying again (Retry-After),
     *  in seconds; null when it did not say. */
    public retryAfter: number | null = null,
    /** The refusal's `code`, when the API names it (`mfa_required`,
     *  `recent_sign_in_required`…): what the site acts on, the message being
     *  for the reader. */
    public code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Told when the API refuses an admin route for want of a second factor
 *  (`mfa_required`): main.ts leads to the page that gives one. */
let secondFactorWanted: (() => void) | null = null;
export function onSecondFactorWanted(run: (() => void) | null) {
  secondFactorWanted = run;
}

/** The refusal a failed answer carries. Fastify/sensible errors put the human
 *  text in `message` and the HTTP reason phrase in `error`; hand-rolled
 *  payloads only set `error`. */
export async function refusalFrom(res: Response): Promise<ApiError> {
  let fields: { message?: unknown; error?: unknown; code?: unknown } = {};
  try {
    fields = ((await res.json()) ?? {}) as typeof fields;
  } catch {
    /* non-JSON error body */
  }
  const text = [fields.message, fields.error].find((t) => typeof t === "string" && t !== "");
  const code = typeof fields.code === "string" ? fields.code : null;
  if (code === "mfa_required") secondFactorWanted?.();
  return new ApiError(
    (text as string | undefined) ?? res.statusText,
    res.status,
    retryAfterOf(res.headers.get("Retry-After")),
    code,
  );
}

/**
 * Whether a path is sent as it was built. The pages build their paths around
 * identifiers they received (a route parameter, a stored id): one that holds
 * dot segments, a backslash, an encoded slash, a fragment or a second host
 * would make the browser ask for another path than the one written, so such a
 * path is not sent at all. The query, after the first `?`, is the caller's.
 */
export function isSendablePath(path: string): boolean {
  const mark = path.indexOf("?");
  const route = mark === -1 ? path : path.slice(0, mark);
  if (!route.startsWith("/") || path.includes("#")) return false;
  if (/\\|%5c|%2f/i.test(route)) return false;
  // An empty segment: `//host`, or an identifier that was empty.
  if (route.slice(1).split("/").includes("")) return false;
  try {
    // The browser's own reading of it: dot segments resolved (encoded ones
    // too), tabs and line breaks dropped. It must name the same segments.
    const read = new URL(path, "http://site.invalid");
    return (
      read.host === "site.invalid" &&
      decodeURIComponent(read.pathname) === decodeURIComponent(route)
    );
  } catch {
    return false;
  }
}

/** A Retry-After header in seconds (delta-seconds or an HTTP date); null when
 *  absent or unreadable. Cross-origin, the API exposes it (server.ts). */
function retryAfterOf(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, (at - Date.now()) / 1000);
}

export async function apiFetch<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  if (!isSendablePath(path)) throw new ApiError("Adresse de requête invalide.", 400);

  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (options.auth) {
    // No client made and no session kept: nobody is signed in, and the
    // client is not downloaded for that (supabaseLazy.ts).
    const client = await clientIfSignedIn();
    const token = client ? (await client.auth.getSession()).data.session?.access_token : undefined;
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  // Only a write may send an email: the test outbox tags it with this
  // browser, and looks again once it is done.
  const write = __TEST_TOOLS__ && (options.method ?? "GET") !== "GET";
  if (write) headers.set("X-Outbox-Viewer", outboxViewer());

  const send = async (signal: AbortSignal | null | undefined): Promise<T> => {
    const res = await fetch(`${baseUrl()}${path}`, { ...options, headers, signal });
    if (write) outboxNudge.value++;

    if (!res.ok) throw await refusalFrom(res);

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };

  // A read has a time limit, its answer read to the end, and is sent once
  // more when it runs out (readTimeout.ts); a write is sent once, unlimited.
  if ((options.method ?? "GET") !== "GET") return send(options.signal);
  return readWithin(send, {
    signal: options.signal,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (timer) => window.clearTimeout(timer as number),
  });
}

/** Convenience helpers. A read may be abandoned through its `signal`. */
export const api = {
  get: <T>(path: string, auth = false, signal?: AbortSignal) =>
    apiFetch<T>(path, { method: "GET", auth, signal }),
  post: <T>(path: string, body?: unknown, auth = true) =>
    apiFetch<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, auth }),
  patch: <T>(path: string, body?: unknown, auth = true) =>
    apiFetch<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined, auth }),
  del: <T>(path: string, auth = true) => apiFetch<T>(path, { method: "DELETE", auth }),
};
