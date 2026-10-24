// The site's Worker on Cloudflare (wrangler.jsonc). Cloudflare serves the web
// app's files itself; only /api/* runs this, forwarded to the API on its own
// host — the same origin for the browser (no CORS), behind the same gate.

interface Env {
  /** The API's own address, e.g. https://…functions.fnc.fr-par.scw.cloud */
  API_ORIGIN: string;
  /** Shared with the API (its PROXY_SECRET): vouches for X-Visitor-IP. */
  PROXY_SECRET?: string;
}

// What the visitor sent that the API must not see: Cloudflare's own headers
// (cf-*: among them the Access token), the cookies (none of the API's), and
// any claim about the visitor's address — the Worker makes its own.
const DROPPED = /^(cf-|cookie$|host$|x-forwarded-|x-real-ip$|x-visitor-ip$|x-proxy-secret$)/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!DROPPED.test(name)) headers.set(name, value);
    }
    // The visitor's address, which the API believes with the secret only:
    // every request reaches it from Cloudflare, one address for everyone.
    const visitor = request.headers.get("cf-connecting-ip");
    if (visitor && env.PROXY_SECRET) {
      headers.set("x-visitor-ip", visitor);
      headers.set("x-proxy-secret", env.PROXY_SECRET);
    }
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "https");

    try {
      return await fetch(new URL(url.pathname + url.search, env.API_ORIGIN), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
        redirect: "manual",
      });
    } catch {
      return Response.json(
        { error: "Le serveur ne répond pas. Réessayez dans un instant." },
        { status: 502 },
      );
    }
  },
};
