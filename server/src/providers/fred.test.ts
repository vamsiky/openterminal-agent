import { afterEach, describe, expect, it, vi } from "vitest";
import { latest, series } from "./fred.js";

const respond = (body: string, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": "text/html" } })));
afterEach(() => vi.unstubAllGlobals());

// FRED's maintenance page: HTML with status 200 whose <link> line has "300,400,700" in it.
const MAINTENANCE = `<!doctype html>\n<html>\n<head>\n    <title>Site Maintenance | St. Louis Fed</title>\n    <link href="https://fonts.googleapis.com/css?family=Open+Sans:300,400,700" rel="stylesheet">\n</head></html>`;

describe("fred", () => {
  it("reads observations from the CSV, skipping missing ones", async () => {
    respond("observation_date,DGS10\n2026-10-19,4.01\n2026-10-20,\n2026-10-21,4.05\n");
    expect(await series("DGS10")).toEqual([{ date: "2026-10-19", value: 4.01 }, { date: "2026-10-21", value: 4.05 }]);
    expect(await latest("DGS10")).toEqual({ date: "2026-10-21", value: 4.05 });
  });

  it("fails on an HTML page served with status 200 instead of reading it as data", async () => {
    respond(MAINTENANCE);
    await expect(latest("DGS10")).rejects.toThrow(/non-CSV/);
  });

  it("fails on an HTTP error", async () => {
    respond("nope", 503);
    await expect(series("VIXCLS")).rejects.toThrow(/503/);
  });
});
