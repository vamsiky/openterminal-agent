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
let watchlists: typeof import("./watchlists.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-watchlists-test-"));
  process.env.DATA_DIR = tmpDir;
  watchlists = await import("./watchlists.js");
  const app = express();
  app.use(express.json());
  app.use("/api/watchlists", watchlists.watchlistsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/watchlists`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  const { db } = await import("../db.js");
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("watchlists routes", () => {
  it("reports a never-saved list as null", async () => {
    const res = await fetch(`${base}/never-saved`);
    expect(await res.json()).toEqual({ name: "never-saved", symbols: null });
  });

  it("saves, uppercases and lists lists oldest first", async () => {
    const res = await post("/Tech", { symbols: ["aapl", "msft"] });
    expect(await res.json()).toEqual({ name: "Tech", symbols: ["AAPL", "MSFT"] });
    await post("/Energy", { symbols: ["xom"] });
    const all = (await (await fetch(base + "/")).json()) as Array<{ name: string }>;
    expect(all.map((l) => l.name)).toEqual(expect.arrayContaining(["Tech", "Energy"]));
    expect(all.findIndex((l) => l.name === "Tech")).toBeLessThan(all.findIndex((l) => l.name === "Energy"));
  });

  it("rejects too many symbols and bad characters", async () => {
    expect((await post("/Big", { symbols: Array.from({ length: 501 }, (_, i) => `S${i}`) })).status).toBe(400);
    expect((await post("/Bad", { symbols: ["a,b"] })).status).toBe(400);
  });

  it("round-trips a name with a space", async () => {
    await post("/To%20buy", { symbols: ["nvda"] });
    expect(await (await fetch(`${base}/To%20buy`)).json()).toEqual({ name: "To buy", symbols: ["NVDA"] });
  });

  it("deletes a list", async () => {
    await post("/Gone", { symbols: ["x"] });
    expect((await fetch(`${base}/Gone`, { method: "DELETE" })).status).toBe(204);
    expect(await (await fetch(`${base}/Gone`)).json()).toEqual({ name: "Gone", symbols: null });
  });

  it("imports a Webull export and rejects bad input", async () => {
    const res = await post("/import", { csv: "Watchlist,#,Symbol,Name,Exchange\nAI,1,crdo,Credo,NASDAQ\nAI,2,btc,Bitcoin,CCC\n" });
    expect(await res.json()).toEqual({ saved: [{ name: "AI", symbols: 2 }], skipped: [] });
    expect(await (await fetch(`${base}/AI`)).json()).toEqual({ name: "AI", symbols: ["CRDO", "BTC-USD"] });
    expect((await post("/import", {})).status).toBe(400);
    const bad = await post("/import", { csv: "foo,bar\n1,2\n" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/Webull/);
  });

  it("reserves the name 'import' in every casing", async () => {
    for (const name of ["import", "Import", "IMPORT"]) {
      expect(watchlists.nameSchema.safeParse(name).success).toBe(false);
      const res = await post(`/${name}`, { csv: "Watchlist,Symbol\nA,AAPL\n" });
      expect(res.status).toBe(200); // the import route, not a list called "Import"
    }
    expect(watchlists.importWebull("Watchlist,Symbol\nImport,AAPL\nOk,MSFT\n")).toEqual({
      saved: [{ name: "Ok", symbols: 1 }],
      skipped: ["Import"],
    });
    expect((await fetch(`${base}/Import`)).status).toBe(400);
  });
});
