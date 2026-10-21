import { afterEach, describe, expect, it, vi } from "vitest";
import { map, OpenFigiError } from "./openfigi.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const job = (i: number) => ({ idType: "TICKER", idValue: `T${i}`, exchCode: "CT" });

/** Answers every job with one record named after its ticker. */
function mockFigi() {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const jobs = JSON.parse(String(init.body)) as Array<{ idValue: string }>;
    return { ok: true, status: 200, json: async () => jobs.map((j) => ({ data: [{ ticker: j.idValue, name: `${j.idValue} CORP`, shareClassFIGI: "BBG1" }] })) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("openfigi.map", () => {
  it("sends 10 jobs a request without a key, 100 with one, and keeps the order", async () => {
    vi.stubEnv("OPENFIGI_API_KEY", "");
    const fetchMock = mockFigi();
    const jobs = Array.from({ length: 23 }, (_, i) => job(i));
    const out = await map(jobs);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.map((r) => r![0].ticker)).toEqual(jobs.map((j) => j.idValue));
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>)["X-OPENFIGI-APIKEY"]).toBeUndefined();

    vi.stubEnv("OPENFIGI_API_KEY", "k");
    fetchMock.mockClear();
    await map(jobs);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>)["X-OPENFIGI-APIKEY"]).toBe("k");
  });

  it("answers [] for an unknown identifier and null for a job that failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ warning: "No identifier found." }, { error: "Invalid idValue." }] }))
    );
    expect(await map([job(1), job(2)])).toEqual([[], null]);
  });

  it("throws on a rate limit, so nothing is taken as 'no listing'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    await expect(map([job(1)])).rejects.toBeInstanceOf(OpenFigiError);
  });
});
