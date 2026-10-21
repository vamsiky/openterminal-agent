import { NextRequest, NextResponse } from "next/server";
import { getApiKey } from "@/lib/api-key";

// A route handler (rather than next.config.ts rewrites) because rewrites
// can't attach a header to the proxied request — and the shared API key
// must never reach the browser, only travel server-to-server.
const API_URL = process.env.API_URL ?? "http://localhost:4000";

// Requests only reach this handler after middleware.ts has checked the Host
// header and, when configured, WEB_PASSWORD — that gate is what stands
// between the network and the API key attached below.
async function proxy(req: NextRequest, path: string[]): Promise<NextResponse> {
  if (path.some((segment) => segment === "." || segment === ".." || segment.includes("/"))) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  // Segments arrive decoded; re-encode them so names with spaces ("To buy") survive.
  const url = `${API_URL}/api/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  const apiKey = getApiKey();

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (apiKey) headers.set("x-api-key", apiKey);
  // Relayed, not fabricated: only meaningful (and only trusted by the API)
  // when TRUST_PROXY=1 is set there — see server/src/index.ts.
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE";

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: hasBody ? await req.text() : undefined,
    cache: "no-store",
  });

  const body = upstream.status === 204 ? null : await upstream.arrayBuffer();
  const responseHeaders = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
  // Set by the API when a market has no data source (e.g. market=eu); the widgets show it.
  const marketNote = upstream.headers.get("x-market-note");
  if (marketNote) responseHeaders.set("x-market-note", marketNote);
  return new NextResponse(body, { status: upstream.status, headers: responseHeaders });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
  return proxy(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: RouteContext) {
  return proxy(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: RouteContext) {
  return proxy(req, (await ctx.params).path);
}
