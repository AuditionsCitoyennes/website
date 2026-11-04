// A thin W3C WebDriver client over fetch, for driving Safari in the iOS
// Simulator through safaridriver (docs/ios-simulator.md). Only what a scripted
// walk needs: one session, navigation, scripts, element clicks, pointer actions
// and a screenshot. No retries anywhere: a session that is not created is an
// answer (remote automation off, the simulator busy), not a flake.

/** The capabilities a simulator session asks for, sent as `alwaysMatch` and nothing else. */
export const SIM_CAPS = {
  browserName: "Safari",
  platformName: "iOS",
  "safari:useSimulator": true,
  "safari:deviceType": "iPhone",
} as const;

/** The W3C key an element reference travels under. */
export const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A W3C error body (`{value: {error, message}}`) with the HTTP status it came with. */
export class WebDriverError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status: number,
  ) {
    super(`${error}: ${message}`);
    this.name = "WebDriverError";
  }
}

async function call<T>(
  f: Fetch,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await f(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: { value?: unknown } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) throw new WebDriverError("unknown error", text.slice(0, 300), res.status);
  }
  // Errors come with a non-2xx status (W3C): a script's own `{error: …}` result is a value.
  if (!res.ok) {
    const value = parsed.value as { error?: string; message?: string } | undefined;
    throw new WebDriverError(value?.error ?? "unknown error", value?.message ?? "", res.status);
  }
  return parsed.value as T;
}

/** The driver's `GET /status` value (`ready` is false while another session holds it). */
export function driverStatus(
  driver: string,
  f: Fetch = fetch,
): Promise<{ ready: boolean; message: string }> {
  return call(f, "GET", `${driver}/status`);
}

/** A W3C Actions input source, as `perform` sends it. */
export interface ActionSequence {
  type: "pointer" | "key" | "none";
  id: string;
  parameters?: { pointerType: "mouse" | "pen" | "touch" };
  actions: Record<string, unknown>[];
}

export interface Session {
  readonly id: string;
  /** What the driver answered: device, OS and browser versions. */
  readonly capabilities: Record<string, unknown>;
  navigate(url: string): Promise<void>;
  refresh(): Promise<void>;
  timeouts(t: { script?: number; pageLoad?: number; implicit?: number }): Promise<void>;
  /** Runs `body` as a function body (`return …`) in the page. */
  execute<T>(body: string, args?: unknown[]): Promise<T>;
  /** Same, with the callback as the last argument. */
  executeAsync<T>(body: string, args?: unknown[]): Promise<T>;
  findAll(css: string): Promise<string[]>;
  click(id: string): Promise<void>;
  perform(actions: { actions: ActionSequence[] }): Promise<void>;
  release(): Promise<void>;
  /** A PNG, base64. */
  screenshot(): Promise<string>;
  delete(): Promise<void>;
}

export async function newSession(
  driver: string,
  caps: Record<string, unknown> = SIM_CAPS,
  f: Fetch = fetch,
): Promise<Session> {
  const v = await call<{ sessionId: string; capabilities: Record<string, unknown> }>(
    f,
    "POST",
    `${driver}/session`,
    { capabilities: { alwaysMatch: caps } },
  );
  const base = `${driver}/session/${v.sessionId}`;
  let deleted = false;
  return {
    id: v.sessionId,
    capabilities: v.capabilities,
    navigate: (url) => call(f, "POST", `${base}/url`, { url }),
    refresh: () => call(f, "POST", `${base}/refresh`, {}),
    timeouts: (t) => call(f, "POST", `${base}/timeouts`, t),
    execute: (script, args = []) => call(f, "POST", `${base}/execute/sync`, { script, args }),
    executeAsync: (script, args = []) => call(f, "POST", `${base}/execute/async`, { script, args }),
    findAll: async (css) => {
      const els = await call<Record<string, string>[]>(f, "POST", `${base}/elements`, {
        using: "css selector",
        value: css,
      });
      return els.map((e) => e[ELEMENT_KEY]);
    },
    click: (id) => call(f, "POST", `${base}/element/${id}/click`, {}),
    perform: (a) => call(f, "POST", `${base}/actions`, a),
    release: () => call(f, "DELETE", `${base}/actions`),
    screenshot: () => call(f, "GET", `${base}/screenshot`),
    delete: async () => {
      if (deleted) return;
      deleted = true;
      await call(f, "DELETE", base);
    },
  };
}

// The sessions withSession holds, deleted by one SIGINT handler before the process exits.
const live = new Set<Session>();
let sigintInstalled = false;

/** Runs `fn` in a new session and deletes the session afterwards, also on a throw or a SIGINT. */
export async function withSession<T>(
  driver: string,
  fn: (s: Session) => Promise<T>,
  caps: Record<string, unknown> = SIM_CAPS,
  f: Fetch = fetch,
): Promise<T> {
  const s = await newSession(driver, caps, f);
  live.add(s);
  if (!sigintInstalled && typeof process !== "undefined") {
    sigintInstalled = true;
    process.once("SIGINT", () => {
      void Promise.allSettled([...live].map((x) => x.delete())).then(() => process.exit(130));
    });
  }
  let failed = false;
  try {
    return await fn(s);
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    live.delete(s);
    // A walk that failed because its session died (a WebContent crash, a reset simulator) gets
    // `invalid session id` back from this delete: the walk's own error is the one thrown.
    await s.delete().catch((e: unknown) => {
      if (!failed) throw e;
      console.warn("session delete failed", e);
    });
  }
}
