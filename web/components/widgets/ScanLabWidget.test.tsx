import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Compare, DefMeta, DefTests, DefView, FormSection, ReplayRow, ScanResult } from "../../lib/scanlab";
import ScanLabWidget from "./ScanLabWidget";

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as Response;
let calls: Array<{ url: string; init?: RequestInit }>;
let table: Array<[string, (init?: RequestInit) => Response]>;
// Later registrations win; among those matching a URL the most specific (longest) path does.
const on = (path: string, fn: (init?: RequestInit) => Response) => table.unshift([path, fn]);
const route = (url: string) => table.filter(([p]) => url.includes(p)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
const posts = (path: string) => calls.filter((c) => c.url.includes(path) && c.init?.method === "POST");

beforeEach(() => {
  calls = [];
  table = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return route(url)?.(init) ?? reply({});
  }));
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noShadow = { on: false, startedAt: null, count: 0, passes: [] };
const meta = (over: Partial<DefMeta>): DefMeta => ({ id: 1, kind: "option", version: "option-v1", status: "active", parentId: null, author: "built-in", sourceText: null, notes: null, createdAt: "2026-10-01T00:00:00Z", promotedAt: null, ...over });
const form = (value: number): FormSection[] => [
  { section: "Listing", items: [
    { path: "listing.minScore", label: "List a setup when it scores at least", value, type: "number", min: 0, max: 100, step: 1, unit: "score_0_100", options: null, readOnly: false, note: null },
    { path: "strategies.long_call.contract", label: "Contract", value: "at-the-money call", type: "text", min: null, max: null, step: null, unit: "", options: null, readOnly: true, note: "Set by the options sweep" },
  ] },
];
const ACTIVE_TEXT = "OPTIONS SCAN · option-v1\n\nLISTING\n- List a setup when it scores 70 or more.";
const activeView: DefView = { meta: meta({}), definition: { listing: { minScore: 70 }, gate: "m15" }, text: ACTIVE_TEXT, form: form(70), diff: [], tests: { replay: null, shadow: noShadow } };
const idea = (symbol: string, score: number, rank: number): ScanResult["ideas"][number] => ({ symbol, strategy: "long_call", contract: null, score, rank });
const result = (ideas: ReturnType<typeof idea>[], extra: Partial<ScanResult> = {}): ScanResult => ({
  at: "2026-10-23T19:56:00Z", scanned: 431, ideas, nearMisses: [], funnel: [{ step: "With data", count: 431, strategy: "long_call" }, { step: "Listed", count: ideas.length, strategy: "long_call" }, { step: "With data", count: 431, strategy: "short_put" }, { step: "Listed", count: 0, strategy: "short_put" }], spread: [{ bucket: "70-75", count: ideas.length }], ...extra,
});
const draftMeta = meta({ id: 2, version: "option-v2", status: "draft", parentId: 1, author: "claude", sourceText: ACTIVE_TEXT.replace("70", "65") });
const replayRow = (): ReplayRow => ({ id: 1, defId: 2, kind: "option", source: "replay", passAt: "2026-10-23T19:56:00Z", createdAt: "2026-10-23T22:00:00Z", live: result([idea("ASAN", 76.8, 1)]), draft: result([idea("ASAN", 76.8, 1)]) });
const compareOf = (over: Partial<Compare>): Compare => ({ source: "replay", at: "2026-10-23T19:56:00Z", live: result([]), draft: result([]), added: [], removed: [], rankChanges: [], ...over });
const draftView = (tests: DefTests = { replay: null, shadow: noShadow }): DefView => ({
  meta: draftMeta, definition: {}, text: "draft text", form: form(65), tests,
  diff: [{ path: "listing.minScore", label: "Listing › List a setup when it scores at least", from: "70", to: "65", change: "changed" }],
});

function serve({ draft = false, tests }: { draft?: boolean; tests?: DefTests } = {}) {
  on("/api/scan/defs?kind=option", () => reply({ active: activeView.meta, draft: draft ? draftMeta : null, versions: draft ? [draftMeta, activeView.meta] : [activeView.meta] }));
  on("/api/scan/defs?kind=stock", () => reply({ active: meta({ id: 9, kind: "stock", version: "stock-v2" }), draft: null, versions: [] }));
  on("/api/scan/defs/1", () => reply(activeView));
  on("/api/scan/defs/2", () => reply(draftView(tests)));
  on("/api/scan/defs/2/compare", () => reply(compareOf({ live: result([idea("ASAN", 76.8, 1)]), draft: result([idea("ASAN", 76.8, 1)]) })));
  on("/api/scan/defs/9", () => reply({ ...activeView, meta: meta({ id: 9, kind: "stock", version: "stock-v2" }), text: "STOCK SCAN · stock-v2" }));
}

const wrap = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ScanLabWidget /></QueryClientProvider>);
};

describe("ScanLabWidget shell", () => {
  it("shows loading, then the tabs, active chip, schedule line and the seeded text", async () => {
    serve();
    wrap();
    expect(screen.getByText("Loading Scan Lab…")).toBeTruthy();
    const box = (await screen.findByLabelText(/Options scan as text/)) as HTMLTextAreaElement;
    expect(box.value).toBe(ACTIVE_TEXT);
    expect(screen.getByRole("tab", { name: "Options scan" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("option-v1", { selector: ".amber" })).toBeTruthy();
    expect(screen.getByText("Every 5 min in market hours")).toBeTruthy();
    expect(screen.getByText("Matches option-v1")).toBeTruthy();
    expect(screen.getByText(/No draft yet/)).toBeTruthy();
  });

  it("shows the route's error when the definitions cannot load", async () => {
    on("/api/scan/defs", () => reply({ error: "boom" }, 500));
    wrap();
    expect(await screen.findByText(/Error: boom/)).toBeTruthy();
  });

  it("switches to the stock scan and its schedule", async () => {
    serve();
    wrap();
    await screen.findByLabelText(/Options scan as text/);
    fireEvent.click(screen.getByRole("tab", { name: "Stock scan" }));
    expect(await screen.findByLabelText(/Stock scan as text/)).toBeTruthy();
    expect(screen.getByText(/Nightly at 07:00 and 16:30 ET/)).toBeTruthy();
  });
});

describe("Text view and Build", () => {
  const edit = async () => {
    const box = (await screen.findByLabelText(/Options scan as text/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: ACTIVE_TEXT.replace("70", "65") } });
    return box;
  };

  it("marks edits, enables Build, and Discard edits restores the active text", async () => {
    serve();
    wrap();
    const box = await edit();
    expect(screen.getByText("Edited · not active")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Build draft with Claude" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(box.value).toBe(ACTIVE_TEXT);
    expect(screen.getByText("Matches option-v1")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Build draft with Claude" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("builds: posts the text, shows 'Claude is reading your text…', then refreshes to the draft", async () => {
    serve();
    let polls = 0;
    on("/api/scan/defs/build", (init) => (init?.method === "POST" ? reply({ jobId: "j1" }, 202) : reply({ status: ++polls < 2 ? "running" : "done", draftId: 2, notes: ["Set the bar to 65."], needsCode: [{ request: "Short-interest filter", reason: "Needs new data." }], error: null, refused: false })));
    wrap();
    await edit();
    fireEvent.click(screen.getByRole("button", { name: "Build draft with Claude" }));
    expect(await screen.findByText("Claude is reading your text…")).toBeTruthy();
    expect(JSON.parse(String(posts("/api/scan/defs/build")[0].init?.body))).toMatchObject({ kind: "option", baseId: 1 });
    serve({ draft: true });
    expect(await screen.findByText("Set the bar to 65.", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request as a code change" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Draft built" })).toBeTruthy();
  });

  it.each([
    [409, /already building/],
    [402, /budget is used up/],
    [503, /turned off/],
  ])("explains a %i answer in plain words", async (status, words) => {
    serve();
    on("/api/scan/defs/build", () => reply({ error: "x" }, status));
    wrap();
    await edit();
    fireEvent.click(screen.getByRole("button", { name: "Build draft with Claude" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(words);
  });

  it("shows a failed build job's reasons", async () => {
    serve();
    on("/api/scan/defs/build", (init) => (init?.method === "POST" ? reply({ jobId: "j2" }, 202) : reply({ status: "error", draftId: null, notes: [], needsCode: [], error: "Weights must add up to 1.", refused: false })));
    wrap();
    await edit();
    fireEvent.click(screen.getByRole("button", { name: "Build draft with Claude" }));
    expect(await screen.findByText("Weights must add up to 1.")).toBeTruthy();
  });
});

describe("Your edits", () => {
  const notes = {
    notes: ["Set the bar to 65."],
    needsCode: [{ request: "Short-interest filter", reason: "Needs new data." }],
    lines: [
      { n: 1, action: "applied", explanation: "Bar is now 65.", text: "- List a setup when it scores 65 or more." },
      { n: 2, action: "needs_code", explanation: "Short interest isn't in the catalog.", text: "- Skip names with short interest above 20%." },
      { n: 3, action: "no_change", explanation: "Already how it works." },
      { n: 4, action: "refused", explanation: "Spreads aren't allowed.", text: "- Add a spread." },
    ],
  };

  it("lists one row per edited line with its tag, and requests code inline on the needs-code row", async () => {
    serve({ draft: true });
    on("/api/scan/defs/2", () => reply({ ...draftView(), meta: { ...draftMeta, notes } }));
    on("/api/scan/code-requests", () => reply({ id: 1 }, 201));
    wrap();
    const list = within(await screen.findByRole("list", { name: "Your edits" }));
    const rows = list.getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText("applied")).toBeTruthy();
    expect(within(rows[0]).getByText("- List a setup when it scores 65 or more.")).toBeTruthy();
    expect(within(rows[1]).getByText("needs code")).toBeTruthy();
    expect(within(rows[2]).getByText("Line 3")).toBeTruthy();
    expect(rows[2].className).toMatch(/opacity-60/);
    expect(within(rows[3]).getByText("refused")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Request as a code change" })).toHaveLength(1);
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Request as a code change" }));
    await waitFor(() => expect(JSON.parse(String(posts("/api/scan/code-requests")[0].init?.body))).toMatchObject({ request: "Short-interest filter" }));
  });

  it("still works for older drafts without lines", async () => {
    serve({ draft: true });
    on("/api/scan/defs/2", () => reply({ ...draftView(), meta: { ...draftMeta, notes: { notes: ["Old note."], needsCode: [] } } }));
    wrap();
    expect(await screen.findByText("Old note.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Your edits" })).toBeNull();
  });

  it("says plainly when the text matches the active scan", async () => {
    serve();
    on("/api/scan/defs/build", (init) => (init?.method === "POST" ? reply({ jobId: "j4" }, 202) : reply({ status: "error", draftId: null, notes: [], needsCode: [], error: "Claude found nothing to change in your text.", refused: false, lines: [] })));
    wrap();
    const box = (await screen.findByLabelText(/Options scan as text/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: box.value + " " + "\n" } });
    fireEvent.change(box, { target: { value: box.value.replace("70", "70.0") } });
    fireEvent.click(screen.getByRole("button", { name: "Build draft with Claude" }));
    expect(await screen.findByText("Your text matches the active scan; nothing to build.")).toBeTruthy();
  });
});

describe("Refused builds", () => {
  it("reads a refusal as a refusal, with the fixed rules", async () => {
    serve();
    on("/api/scan/defs/build", (init) => (init?.method === "POST" ? reply({ jobId: "j3" }, 202) : reply({ status: "error", draftId: null, notes: ["No long puts."], needsCode: [], error: "Long puts aren't allowed.", refused: true })));
    wrap();
    const box = (await screen.findByLabelText(/Options scan as text/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: box.value + "\n- Buy puts." } });
    fireEvent.click(screen.getByRole("button", { name: "Build draft with Claude" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Claude can't build that/);
    expect(alert.textContent).toMatch(/Long puts aren't allowed/);
    expect(alert.textContent).toMatch(/never places orders/);
  });
});

describe("Draft card", () => {
  const tested: DefTests = { replay: replayRow(), shadow: noShadow };

  it("shows the diff, the notes and requests a code change", async () => {
    serve({ draft: true, tests: tested });
    on("/api/scan/defs/2", () => reply({ ...draftView(tested), meta: { ...draftMeta, notes: { notes: ["Kept the early bar at 60."], needsCode: [{ request: "Short interest needs a new input.", reason: "" }] } } }));
    on("/api/scan/code-requests", () => reply({ id: 1 }, 201));
    wrap();
    expect(await screen.findByText("Listing › List a setup when it scores at least")).toBeTruthy();
    expect(screen.getByText("changed")).toBeTruthy();
    expect(screen.getByText("Kept the early bar at 60.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Request as a code change" }));
    expect(await screen.findByText("Requested")).toBeTruthy();
    expect(JSON.parse(String(posts("/api/scan/code-requests")[0].init?.body))).toMatchObject({ kind: "option", draftId: 2, request: "Short interest needs a new input." });
  });

  it("flags a draft as out of date when the text moves off what Claude read", async () => {
    serve({ draft: true, tests: tested });
    wrap();
    const box = (await screen.findByLabelText(/Options scan as text/)) as HTMLTextAreaElement;
    await screen.findByText("What changes");
    expect(screen.queryByText(/The text changed after this draft/)).toBeNull();
    fireEvent.change(box, { target: { value: box.value + "\n- more" } });
    expect(screen.getByText(/The text changed after this draft was built/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Promote to active" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("runs a replay, then compares: ideas, gates and spread", async () => {
    serve({ draft: true });
    on("/api/scan/defs/2/replay", () => reply({ ok: true }));
    wrap();
    const run = await screen.findByRole("button", { name: "Run replay" });
    serve({ draft: true, tests: tested });
    on("/api/scan/defs/2/compare", () => reply(compareOf({
      live: result([idea("ASAN", 76.8, 1)]),
      draft: result([idea("ASAN", 76.8, 1), idea("D", 68, 2)], { nearMisses: [idea("ISRG", 63.5, 3)], funnel: [{ step: "With data", count: 431, strategy: "long_call" }, { step: "Listed", count: 2, strategy: "long_call" }, { step: "With data", count: 431, strategy: "short_put" }, { step: "Listed", count: 0, strategy: "short_put" }] }),
      added: [idea("D", 68, 2)],
    })));

    fireEvent.click(run);
    await waitFor(() => expect(posts("/api/scan/defs/2/replay")).toHaveLength(1));
    expect(JSON.parse(String(posts("/api/scan/defs/2/replay")[0].init?.body))).toEqual({ source: "latest" });
    await waitFor(() => expect(screen.getByText("new")).toBeTruthy());
    expect(screen.getByText("ISRG")).toBeTruthy();
    expect(screen.getByText(/D comes in/)).toBeTruthy();
    const cmp = screen.getByRole("group", { name: "Compare" });
    fireEvent.click(within(cmp).getByRole("button", { name: "Gates" }));
    // The two strategies each have their own "With data" and "Listed" rows.
    const buy = within(screen.getByRole("group", { name: "Buy a call" }));
    const sell = within(screen.getByRole("group", { name: "Sell a cash-secured put" }));
    expect(buy.getAllByText("Listed")).toHaveLength(1);
    expect(buy.getByText("2", { selector: ".amber" })).toBeTruthy();
    expect(sell.getByText("With data")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Sell a covered call" })).toBeNull();
    fireEvent.click(within(cmp).getByRole("button", { name: "Score spread" }));
    expect(screen.getByText("70-75")).toBeTruthy();
  });

  it("starts live shadow and lists its passes", async () => {
    serve({ draft: true, tests: { replay: null, shadow: { on: true, startedAt: "2026-10-23T13:30:00Z", count: 1, passes: [{ at: "2026-10-23T13:35:00Z", live: result([idea("A", 71, 1)]), draft: result([idea("A", 71, 1), idea("B", 66, 2)]) }] } } });
    on("/api/scan/defs/2/shadow", () => reply({ on: false }));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Live shadow" }));
    expect(await screen.findByText("9:35 AM")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop live shadow" }));
    await waitFor(() => expect(JSON.parse(String(posts("/api/scan/defs/2/shadow")[0].init?.body))).toEqual({ on: false }));
  });

  it("needs a replay before promoting, then confirms and posts the promote", async () => {
    serve({ draft: true });
    wrap();
    const promote = (await screen.findByRole("button", { name: "Promote to active" })) as HTMLButtonElement;
    expect(promote.disabled).toBe(true);
    cleanup();
    serve({ draft: true, tests: tested });
    on("/api/scan/defs/2/promote", () => reply({ ok: true }));
    wrap();
    const ready = await screen.findByRole("button", { name: "Promote to active" });
    await waitFor(() => expect((ready as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(ready);
    expect(screen.getByText(/Make option-v2 the active options scan/)).toBeTruthy();
    expect(screen.getByText(/option-v1 stays in Versions/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make option-v2 active" }));
    await waitFor(() => expect(posts("/api/scan/defs/2/promote")).toHaveLength(1));
  });

  it("shows the server's refusal when a promote is rejected", async () => {
    serve({ draft: true, tests: tested });
    on("/api/scan/defs/2/promote", () => reply({ error: "run a replay first" }, 409));
    wrap();
    const ready = await screen.findByRole("button", { name: "Promote to active" });
    await waitFor(() => expect((ready as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(ready);
    fireEvent.click(screen.getByRole("button", { name: "Make option-v2 active" }));
    expect(await screen.findByText("run a replay first")).toBeTruthy();
  });

  it("discards the draft", async () => {
    serve({ draft: true, tests: tested });
    on("/api/scan/defs/2/discard", () => reply({ ok: true }));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(posts("/api/scan/defs/2/discard")).toHaveLength(1));
  });
});

describe("Settings, Versions and Data views", () => {
  it("saves a changed number as a draft, with only the changed path", async () => {
    serve();
    on("/api/scan/defs/draft", () => reply({ meta: draftMeta }, 201));
    wrap();
    await screen.findByLabelText(/Options scan as text/);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const input = (await screen.findByLabelText("List a setup when it scores at least")) as HTMLInputElement;
    expect(screen.getByText("Set by the options sweep")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save as draft" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "65" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(posts("/api/scan/defs/draft")).toHaveLength(1));
    expect(JSON.parse(String(posts("/api/scan/defs/draft")[0].init?.body))).toEqual({ kind: "option", baseId: 1, edits: [{ path: "listing.minScore", value: 65 }] });
  });

  it("holds back Save for an out-of-range value", async () => {
    serve();
    wrap();
    await screen.findByLabelText(/Options scan as text/);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(await screen.findByLabelText("List a setup when it scores at least"), { target: { value: "150" } });
    expect((screen.getByRole("button", { name: "Save as draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("A value is outside its range.")).toBeTruthy();
  });

  it("lists versions with Promote on the draft and Roll back on the previous one", async () => {
    const prev = meta({ id: 0, version: "option-v0", status: "previous" });
    on("/api/scan/defs?kind=option", () => reply({ active: activeView.meta, draft: draftMeta, versions: [draftMeta, activeView.meta, prev] }));
    on("/api/scan/defs/1", () => reply(activeView));
    on("/api/scan/defs/2", () => reply(draftView({ replay: replayRow(), shadow: noShadow })));
    on("/api/scan/defs/0/rollback", () => reply({ ok: true }));
    wrap();
    await screen.findByLabelText(/Options scan as text/);
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    expect(await screen.findByText("option-v0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Promote" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(posts("/api/scan/defs/0/rollback")).toHaveLength(1));
  });

  it("shows the catalog grouped, searchable, marks used keys and copies a key", async () => {
    serve();
    on("/api/scan/catalog", () => reply({ fields: [
      { key: "m15", scope: "option", label: "15-minute momentum", unit: "score_pm100", description: "Momentum over 15 minutes.", source: "Alpaca bars", group: "Momentum" },
      { key: "atm_iv", scope: "option", label: "ATM implied volatility", unit: "pct", description: "IV at the money.", source: "Alpaca snapshots", group: "Volatility" },
    ] }));
    wrap();
    await screen.findByLabelText(/Options scan as text/);
    fireEvent.click(screen.getByRole("button", { name: "Data available" }));
    expect(await screen.findByText("15-minute momentum")).toBeTruthy();
    expect(screen.getAllByText("used")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search fields"), { target: { value: "implied" } });
    expect(screen.queryByText("15-minute momentum")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "atm_iv" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("atm_iv"));
    fireEvent.change(screen.getByLabelText("Search fields"), { target: { value: "zzz" } });
    expect(screen.getByText(/No field matches/)).toBeTruthy();
  });
});
