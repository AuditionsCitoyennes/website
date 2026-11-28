import { BAN_URL } from "./fakes";

// In-process stand-ins for the third parties the API calls — the BAN,
// geo.api.gouv.fr, Resend and Anthropic — behind globalThis.fetch, for
// node:test. Unlike the fakes of testing/fakes.ts, which answer as the real
// services do, these answer whatever a test tells them to: a redirect, a
// body of any size or shape, late, or never. Installed over the fetch of the
// moment (testing/fakes.ts's installFakes first, when a test wants both):
// what is not theirs goes on to it.

export const SERVICES = {
  ban: BAN_URL,
  geo: "https://geo.api.gouv.fr",
  resend: "https://api.resend.com",
  anthropic: "https://api.anthropic.com",
} as const;

export type Service = keyof typeof SERVICES;

/** One call a service received. */
export interface UpstreamCall {
  service: Service;
  url: URL;
  method: string;
  /** How the caller asked redirects to be treated (fetch's default: "follow"). */
  redirect: Request["redirect"];
  headers: Headers;
  body: string;
}

/** What a service answers a call with; `signal` is the caller's, to end a wait on. */
export type Answer = (call: UpstreamCall, signal: AbortSignal) => Response | Promise<Response>;

export class FakeUpstreams {
  /** Every call received, in order. */
  calls: UpstreamCall[] = [];
  /** What a followed redirect carried to where it pointed (a caller that refuses redirects leaves it empty). */
  elsewhere: UpstreamCall[] = [];
  answers: Partial<Record<Service, Answer>> = {};

  /** The calls one service received. */
  of(service: Service): UpstreamCall[] {
    return this.calls.filter((c) => c.service === service);
  }

  /** Forget the calls and the answers. */
  reset(): void {
    this.calls = [];
    this.elsewhere = [];
    this.answers = {};
  }
}

/** A 307 to `location`. */
export const redirectTo = (location: string) =>
  new Response(null, { status: 307, headers: { location } });

/** A JSON answer of about `bytes` bytes: `value` with one long field more. */
export function heavy(bytes: number, value: Record<string, unknown> = {}, status = 200): Response {
  return Response.json({ ...value, pad: "x".repeat(bytes) }, { status });
}

/** An answer that never comes: the call ends when its caller gives up. */
export const never: Answer = (_call, signal) =>
  new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });

/** `answer`, `ms` later (or the caller's abort, if sooner). */
export const late =
  (ms: number, answer: () => Response): Answer =>
  (_call, signal) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(answer()), ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });

/**
 * Route the four services' origins to `up`; returns the function that puts
 * the previous fetch back. A 3xx answer is treated as fetch treats it: the
 * call fails when its caller asked `redirect: "error"`, else it is followed
 * — recorded in `up.elsewhere`, with the headers and body it carried.
 */
export function installUpstreams(up: FakeUpstreams): () => void {
  const previous = globalThis.fetch;
  const byOrigin = new Map<string, Service>(
    (Object.keys(SERVICES) as Service[]).map((s) => [new URL(SERVICES[s]).origin, s]),
  );
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const service = byOrigin.get(url.origin);
    if (!service) return previous(input, init);
    const call: UpstreamCall = {
      service,
      url,
      method: req.method,
      redirect: req.redirect,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? "" : await req.text(),
    };
    up.calls.push(call);
    const answer = up.answers[service];
    if (!answer) throw new Error(`no answer set for ${service}`);
    req.signal.throwIfAborted();
    const res = await answer(call, req.signal);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (req.redirect === "error") {
        throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
      }
      up.elsewhere.push({ ...call, url: new URL(location) });
      return Response.json({});
    }
    return res;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}
