import { supabase } from "./supabase";
import { outboxNudge, outboxViewer } from "./outbox";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

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
  ) {
    super(message);
    this.name = "ApiError";
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
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (options.auth) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  // Only a write may send an email: the test outbox tags it with this
  // browser, and looks again once it is done.
  const write = __TEST_TOOLS__ && (options.method ?? "GET") !== "GET";
  if (write) headers.set("X-Outbox-Viewer", outboxViewer());

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (write) outboxNudge.value++;

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      // Fastify/sensible errors put the human text in `message` and the HTTP
      // reason phrase in `error` — prefer the former; hand-rolled payloads
      // only set `error`.
      message = body.message || body.error || message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, retryAfterOf(res.headers.get("Retry-After")));
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
