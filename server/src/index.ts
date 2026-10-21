import "./env.js";
import express from "express";
import cors from "cors";
import { marketRouter } from "./routes/market.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { aiRouter } from "./routes/ai.js";
import { watchlistsRouter } from "./routes/watchlists.js";
import { barsRouter } from "./routes/bars.js";
import { estimatesRouter } from "./routes/estimates.js";
import { researchRouter } from "./routes/research/index.js";
import { startEstimateCapture } from "./estimates/capture.js";
import { startBulkJobs } from "./research/bulk-store.js";
import { startContentJobs } from "./research/transcripts-job.js";
import { startHistoryScheduler } from "./history/scheduler.js";
import * as alpaca from "./providers/alpaca.js";
import { allStats } from "./providers/registry.js";
import { hasApiKey, requireApiKey } from "./auth.js";
import * as live from "./live/feed.js";
import { rateLimit } from "./rateLimit.js";

const app = express();

// Off by default: req.ip then falls back to the immediate socket address
// (the bundled web proxy's own address when called through it), so every
// caller behind that proxy shares one rate-limit bucket — safe, if coarser
// than per-browser. Only set TRUST_PROXY=1 if you know exactly one trusted
// reverse proxy sits in front of this process (the bundled web proxy alone,
// or your own proxy in front of it that itself sets X-Forwarded-For from
// the real client and doesn't let callers inject their own value) —
// otherwise a caller can forge X-Forwarded-For to dodge the rate limit.
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

// Only the configured web origin may call this API from a browser. Without
// this, any website open in the same browser as the terminal could reach a
// server bound beyond localhost — cors() with no options reflects every
// origin.
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
app.use(cors({ origin: webOrigin }));
app.use(express.json({ limit: "1mb" }));

// No API key here by design (market.ts routes serve read-only market data),
// but still bounded per-IP: unlike /api/ai and /api/portfolios, an unauthenticated
// caller could otherwise repeat the multi-provider fan-out in market.ts (dozens
// of outbound calls per request — see webQuoteMap) fast enough to use up this
// deployment's Alpaca/FMP request budgets or get its IP banned by Stooq/SEC.
// The bundled web app is exempt: all its panels share one bucket through its
// proxy, and four of them (quote, watchlist, macro, crypto) poll every second,
// which can use the whole 240 and leave a click waiting on a 429 retry. It is gated by its own
// middleware (Host check, WEB_PASSWORD), and live quotes are served from memory.
app.use("/api", rateLimit({ windowMs: 60_000, max: 240, skip: hasApiKey }), marketRouter);
// Portfolio data and the paid AI endpoint require a shared secret; see auth.ts.
app.use("/api/portfolios", requireApiKey, portfolioRouter);
app.use("/api/watchlists", requireApiKey, watchlistsRouter);
// Daily consensus-estimate snapshots (estimates/); served from the local database.
app.use("/api/estimates", requireApiKey, estimatesRouter);
// FMP research datasets for the analysis agents (routes/research/).
app.use("/api/research", requireApiKey, researchRouter);
// Locally stored price history (history/); read-only, no provider calls.
app.use("/api/bars", barsRouter);
app.use(
  "/api/ai",
  requireApiKey,
  rateLimit({ windowMs: 60_000, max: 10 }),
  aiRouter
);

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    providers: allStats(),
    ai: Boolean(process.env.ANTHROPIC_API_KEY),
    alpaca: alpaca.isConfigured(),
    live: live.status(),
  });
});

const PORT = Number(process.env.API_PORT ?? 4000);
// Bind to localhost by default so cloning and running this never exposes an
// unauthenticated-by-default API to the network. Set API_HOST=0.0.0.0 (and
// API_KEY + WEB_ORIGIN) to intentionally expose it beyond this machine.
const HOST = process.env.API_HOST ?? "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`OpenTerminal API listening on http://${HOST}:${PORT}`);
});

startHistoryScheduler();
startEstimateCapture();
// Whole-market FMP bulk tables (daily/weekly) and earnings-call transcripts for watchlists.
startBulkJobs();
startContentJobs();
live.startLiveFeed();
