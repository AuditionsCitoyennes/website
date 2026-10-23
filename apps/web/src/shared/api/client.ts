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
  ) {
    super(message);
    this.name = "ApiError";
  }
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
  const write = __OUTBOX__ && (options.method ?? "GET") !== "GET";
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
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Convenience helpers. */
export const api = {
  get: <T>(path: string, auth = false) => apiFetch<T>(path, { method: "GET", auth }),
  post: <T>(path: string, body?: unknown, auth = true) =>
    apiFetch<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, auth }),
  patch: <T>(path: string, body?: unknown, auth = true) =>
    apiFetch<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined, auth }),
  del: <T>(path: string, auth = true) => apiFetch<T>(path, { method: "DELETE", auth }),
};
