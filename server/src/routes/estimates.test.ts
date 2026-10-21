import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let server: Server;
let base: string;
let store: typeof import("../estimates/store.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-estimates-route-test-"));
  process.env.DATA_DIR = tmpDir;
  store = await import("../estimates/store.js");
  const { estimatesRouter } = await import("./estimates.js");
  const app = express();
  app.use("/api/estimates", estimatesRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/estimates`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  const { db } = await import("../db.js");
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const day = (offset: number) => store.addDays(new Date().toISOString().slice(0, 10), offset);

describe("GET /api/estimates/:symbol", () => {
  it("answers an untracked symbol with next null", async () => {
    const body = await (await fetch(`${base}/nope`)).json();
    expect(body).toMatchObject({ symbol: "NOPE", next: null, history: [] });
    expect(body.revisions["7d"]).toEqual({ eps: null, revenue: null });
  });

  it("returns the next report, its history and revisions", async () => {
    const report = day(20);
    store.recordSnapshots([{ symbol: "NVDA", reportDate: report, eps: 2.0, revenue: 100 }], day(-40));
    store.recordSnapshots([{ symbol: "NVDA", reportDate: report, eps: 2.2, revenue: 100 }], day(-3));
    // An earlier, already-past report must not be picked as "next".
    store.recordSnapshots([{ symbol: "NVDA", reportDate: day(-30), eps: 1, revenue: 1 }], day(-40));
    const body = await (await fetch(`${base}/nvda`)).json();
    expect(body.next).toEqual({ reportDate: report, eps: 2.2, revenue: 100 });
    expect(body.history).toEqual([
      { day: day(-40), eps: 2.0, revenue: 100 },
      { day: day(-3), eps: 2.2, revenue: 100 },
    ]);
    expect(body.revisions["7d"].eps).toBeCloseTo(10);
    expect(body.revisions["30d"].eps).toBeCloseTo(10);
    expect(body.revisions["60d"].eps).toBeNull();
    expect(body.revisions["7d"].revenue).toBeCloseTo(0);
  });

  it("honours ?report= and rejects bad input", async () => {
    const past = day(-30);
    const body = await (await fetch(`${base}/NVDA?report=${past}`)).json();
    expect(body.next).toEqual({ reportDate: past, eps: 1, revenue: 1 });
    expect((await fetch(`${base}/NVDA?report=soon`)).status).toBe(400);
    expect((await fetch(`${base}/bad%20sym`)).status).toBe(400);
  });
});
