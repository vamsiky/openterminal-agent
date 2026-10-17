import { afterEach, describe, expect, it, vi } from "vitest";
import { series } from "./fred.js";

const CSV = "observation_date,VIXCLS\r\n2026-10-14,18.2\r\n2026-10-15,.\r\n2026-10-15,\r\n2026-10-16,21.5\r\n";

describe("fred provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses the CSV, skips missing values and sends a non-browser User-Agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => CSV });
    vi.stubGlobal("fetch", fetchMock);
    expect(await series("VIXCLS")).toEqual([
      { date: "2026-10-14", value: 18.2 },
      { date: "2026-10-16", value: 21.5 },
    ]);
    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toBe("openterminal/0.1");
  });

  it("reports HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }));
    await expect(series("VIXCLS")).rejects.toThrow("fred 503");
  });
});
