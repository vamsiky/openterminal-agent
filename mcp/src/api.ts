import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  /** Longest text (characters) a tool returns before it truncates. */
  maxChars: number;
  timeoutMs: number;
}

/** Thrown for anything the agent should read as a tool error. */
export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readKeyFile(): string {
  const file = join(process.env.DATA_DIR ?? join(repoRoot, "data"), ".api-key");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

export function configFromEnv(env = process.env): ApiConfig {
  const maxChars = Number(env.OPENTERMINAL_MAX_CHARS);
  return {
    baseUrl: (env.OPENTERMINAL_API_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, ""),
    apiKey: env.OPENTERMINAL_API_KEY || readKeyFile(),
    maxChars: Number.isFinite(maxChars) && maxChars >= 1000 ? Math.floor(maxChars) : 40_000,
    timeoutMs: 60_000,
  };
}

export type Params = Record<string, string | number | boolean | undefined | null>;

/** GET `path` on the app and return the parsed JSON. Read-only by construction: there is no other verb. */
export async function apiGet(cfg: ApiConfig, path: string, params: Params = {}): Promise<any> {
  const url = new URL(cfg.baseUrl + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": cfg.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new ApiError(`cannot reach the OpenTerminal API at ${cfg.baseUrl} (${why}). Is \`npm run dev\` running?`);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = typeof body?.error === "string" ? body.error : text.slice(0, 200) || res.statusText;
    const feature = typeof body?.feature === "string" ? ` [${body.feature}]` : "";
    const hint = res.status === 401 ? " (set OPENTERMINAL_API_KEY or create data/.api-key by starting the app once)" : "";
    throw new ApiError(`${res.status} ${msg}${feature}${hint}`, res.status);
  }
  return body;
}
