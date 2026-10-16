import { NextRequest, NextResponse } from "next/server";

// The API proxy (app/api/[...path]/route.ts) attaches the shared API key to
// every request it forwards, so whoever can load this app can use the
// key-protected portfolio and AI routes. This gate decides who that is:
//
// - Only loopback Host names are served by default. That also blocks DNS
//   rebinding, where a malicious page points its own domain at 127.0.0.1 and
//   calls this app from the victim's browser under that domain.
// - WEB_ALLOWED_HOSTS (comma-separated hostnames) opts into serving more
//   names, and then WEB_PASSWORD is required: a non-loopback name means
//   other machines can reach the app. The same goes for a loopback name
//   that arrives through a proxy for a non-loopback client (see below).
// - WEB_PASSWORD, when set, puts the whole app behind HTTP Basic auth (any
//   username). The browser then sends it on every same-origin fetch too.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostname(host: string): string {
  // "[::1]:3000" -> "[::1]", "localhost:3000" -> "localhost"
  const end = host.startsWith("[") ? host.indexOf("]") + 1 : host.lastIndexOf(":");
  return (end > 0 ? host.slice(0, end) : host).toLowerCase();
}

// Next fills X-Forwarded-For with the socket address when the client sent
// none, and keeps (and appends to) whatever a proxy in front sent. A local
// tunnel or reverse proxy (ngrok with --host-header=rewrite, Caddy, etc.)
// can therefore present Host: localhost for a remote caller; its
// X-Forwarded-For entry is what gives that caller away.
function fromLoopbackOnly(req: NextRequest): boolean {
  const chain = (req.headers.get("x-forwarded-for") ?? "").split(",").map((a) => a.trim());
  return chain.every((addr) => addr === "" || /^(::ffff:)?127\./.test(addr) || addr === "::1");
}

function extraHosts(): Set<string> {
  return new Set(
    (process.env.WEB_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function basicAuthPassword(req: NextRequest): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice("Basic ".length));
    return decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return null;
  }
}

function forbidden(message: string): NextResponse {
  return new NextResponse(message, { status: 403, headers: { "content-type": "text/plain" } });
}

export function middleware(req: NextRequest): NextResponse {
  const host = hostname(req.headers.get("host") ?? "");
  const loopbackHost = LOOPBACK_HOSTS.has(host);
  if (!loopbackHost && !extraHosts().has(host)) {
    return forbidden(`Host "${host}" is not allowed. Add it to WEB_ALLOWED_HOSTS (and set WEB_PASSWORD).`);
  }

  const loopback = loopbackHost && fromLoopbackOnly(req);
  const password = process.env.WEB_PASSWORD;
  if (!loopback && !password) {
    return forbidden("WEB_PASSWORD must be set to serve this app beyond localhost (including through a tunnel).");
  }
  if (password) {
    const provided = basicAuthPassword(req);
    if (provided === null || !constantTimeEqual(provided, password)) {
      return new NextResponse("Authentication required", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="OpenTerminal", charset="UTF-8"' },
      });
    }
  }

  // Defense in depth against cross-site requests: a state-changing call must
  // come from a page on this same host.
  const origin = req.headers.get("origin");
  if (!SAFE_METHODS.has(req.method) && origin !== null) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      // "null" or malformed origins fall through to the mismatch below.
    }
    if (originHost !== (req.headers.get("host") ?? "").toLowerCase()) {
      return forbidden("Cross-origin request rejected.");
    }
  }

  return NextResponse.next();
}

export const config = {
  // Node.js runtime so WEB_PASSWORD / WEB_ALLOWED_HOSTS are read when the
  // server starts; the default edge runtime inlines process.env at build time.
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
