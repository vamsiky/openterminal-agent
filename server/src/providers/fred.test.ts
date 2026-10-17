import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const CSV = "observation_date,VIXCLS\n2026-10-14,18.2\n2026-10-15,.\n2026-10-16,21.5\n";

vi.mock("node:https", () => ({
  get: vi.fn((_url: string, _opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    queueMicrotask(() => {
      cb(res);
      res.emit("data", Buffer.from(CSV));
      res.emit("end");
    });
    return req;
  }),
}));

const { series } = await import("./fred.js");

describe("fred provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses the CSV and skips missing values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => CSV }));
    expect(await series("VIXCLS")).toEqual([
      { date: "2026-10-14", value: 18.2 },
      { date: "2026-10-16", value: 21.5 },
    ]);
  });

  it("falls back to HTTP/1.1 when fetch throws (HTTP/2 stream errors on some Node versions)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await series("VIXCLS")).toHaveLength(2);
  });

  it("reports HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }));
    await expect(series("VIXCLS")).rejects.toThrow("fred 503");
  });
});
