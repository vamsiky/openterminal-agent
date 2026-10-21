"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiGet, apiPost, apiPut } from "../../lib/api";
import { ago, type ImportError, type PositionsResponse, type UniverseSettings } from "../../lib/ideas";
import ErrorNote from "../ErrorNote";

type UniverseResponse = { settings: UniverseSettings; symbolCount: number };
type Watchlist = { id?: number; name: string; symbols: string[] };
type Sectors = { sectors: string[]; industries?: Array<string | { sector?: string; industry: string }> };

const MODES: Array<[UniverseSettings["mode"], string]> = [
  ["watchlists", "Watchlists"],
  ["sector", "Sectors"],
  ["market", "Whole market"],
];

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function Chips<T extends string | number>({ options, selected, onChange }: { options: Array<[T, string]>; selected: T[]; onChange: (v: T[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(([value, label]) => (
        <button key={String(value)} className={`term-btn ${selected.includes(value) ? "active" : ""}`} onClick={() => onChange(toggle(selected, value))}>
          {label}
        </button>
      ))}
    </div>
  );
}

export default function IdeasSettings() {
  const client = useQueryClient();
  const universe = useQuery({ queryKey: ["scan-universe"], queryFn: () => apiGet<UniverseResponse>("/api/scan/universe") });
  const lists = useQuery({ queryKey: ["watchlists-api"], queryFn: () => apiGet<Watchlist[]>("/api/watchlists") });
  const sectors = useQuery({ queryKey: ["scan-sectors"], queryFn: () => apiGet<Sectors>("/api/scan/sectors"), staleTime: 3_600_000 });
  const positions = useQuery({ queryKey: ["positions"], queryFn: () => apiGet<PositionsResponse>("/api/positions") });

  const [draft, setDraft] = useState<UniverseSettings | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (universe.data && !draft) setDraft(universe.data.settings);
  }, [universe.data, draft]);

  const save = async () => {
    if (!draft) return;
    setSaved("Saving…");
    try {
      const res = await apiPut<UniverseResponse>("/api/scan/universe", draft);
      setDraft(res.settings);
      client.setQueryData(["scan-universe"], res);
      client.invalidateQueries({ queryKey: ["ideas"] });
      setSaved(`Saved: ${res.symbolCount} symbols in the universe.`);
    } catch (err) {
      setSaved(`Save failed: ${(err as Error).message}`);
    }
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<ImportError[]>([]);
  const importCsv = async (file: File) => {
    setImportMsg("Importing…");
    setImportErrors([]);
    try {
      const res = await apiPost<{ imported: number }>("/api/positions/import", { csv: await file.text(), filename: file.name });
      setImportMsg(`Imported ${res.imported} positions from ${file.name}.`);
      client.invalidateQueries({ queryKey: ["positions"] });
      client.invalidateQueries({ queryKey: ["scan-universe"] });
    } catch (err) {
      const raw = err instanceof ApiError ? (err.body as { errors?: ImportError[] } | undefined)?.errors : undefined;
      const errors = Array.isArray(raw) ? raw : [];
      setImportErrors(errors);
      setImportMsg(errors.length ? `Nothing imported: ${errors.length} invalid row${errors.length === 1 ? "" : "s"}.` : `Import failed: ${(err as Error).message}`);
    }
  };

  if (universe.error) return <ErrorNote error={universe.error} />;
  if (!draft) return <div className="p-2 dim">Loading settings…</div>;

  const set = (patch: Partial<UniverseSettings>) => setDraft({ ...draft, ...patch });
  const num = (v: string) => (v === "" || !isFinite(Number(v)) ? 0 : Number(v));
  const withIds = (Array.isArray(lists.data) ? lists.data : []).filter((l): l is Watchlist & { id: number } => typeof l.id === "number");
  const industryOptions = (sectors.data?.industries ?? []).map((i) => (typeof i === "string" ? i : i.industry));
  const heldCount = positions.data?.positions.length ?? 0;

  return (
    <div className="p-2 flex flex-col gap-2 text-[11px] border-b border-[var(--border)]">
      <div>
        <div className="dim uppercase text-[10px] mb-1">Universe {universe.data ? `(${universe.data.symbolCount} symbols now, holdings always included)` : ""}</div>
        <div className="flex gap-1 mb-1">
          {MODES.map(([mode, label]) => (
            <button key={mode} className={`term-btn ${draft.mode === mode ? "active" : ""}`} onClick={() => set({ mode })}>
              {label}
            </button>
          ))}
        </div>
        {draft.mode === "watchlists" &&
          (withIds.length ? (
            <div>
              <div className="dim mb-1">{draft.watchlistIds === null ? "Every watchlist (select to narrow)" : `${draft.watchlistIds.length} selected`}</div>
              <Chips options={withIds.map((l) => [l.id, l.name] as [number, string])} selected={draft.watchlistIds ?? []} onChange={(ids) => set({ watchlistIds: ids.length ? ids : null })} />
            </div>
          ) : (
            <div className="dim">Using every watchlist.</div>
          ))}
        {draft.mode === "sector" && (
          <div className="flex flex-col gap-1">
            {sectors.error ? <ErrorNote error={sectors.error} /> : <Chips options={(sectors.data?.sectors ?? []).map((s) => [s, s] as [string, string])} selected={draft.sectors} onChange={(v) => set({ sectors: v })} />}
            {industryOptions.length > 0 && (
              <select
                multiple
                size={4}
                value={draft.industries}
                onChange={(e) => set({ industries: Array.from(e.target.selectedOptions, (o) => o.value) })}
                title="Optional industry narrowing (ctrl/cmd-click for several)"
              >
                {industryOptions.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            )}
          </div>
        )}
        {draft.mode !== "watchlists" && (
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <label className="flex items-center gap-1">Min price
              <input type="number" min={0} className="w-16" value={draft.minPrice} onChange={(e) => set({ minPrice: num(e.target.value) })} />
            </label>
            <label className="flex items-center gap-1">Min $ volume
              <input type="number" min={0} step={1_000_000} className="w-28" value={draft.minAvgDollarVolume} onChange={(e) => set({ minAvgDollarVolume: num(e.target.value) })} />
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={draft.requireOptions} onChange={(e) => set({ requireOptions: e.target.checked })} /> Require options
            </label>
          </div>
        )}
        <div className="flex items-center gap-2 mt-1">
          <button className="term-btn" onClick={save}>Save</button>
          {saved && <span className="dim">{saved}</span>}
        </div>
      </div>

      <div>
        <div className="dim uppercase text-[10px] mb-1">Positions</div>
        <div className="flex items-center gap-2">
          <button className="term-btn" onClick={() => fileInput.current?.click()} title="CSV: symbol, quantity, cost, opened_at; options add type, expiry, strike, right (or an OCC symbol). Replaces the current snapshot.">
            Upload CSV
          </button>
          <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f); e.target.value = ""; }} />
          <span className="dim">
            {positions.data ? `${heldCount} position${heldCount === 1 ? "" : "s"}${positions.data.importedAt ? `, imported ${ago(positions.data.importedAt)}` : ""}` : positions.error ? "positions unavailable" : "…"}
          </span>
        </div>
        {importMsg && <div className={importErrors.length ? "down mt-1" : "dim mt-1"}>{importMsg}</div>}
        {importErrors.length > 0 && (
          <ul className="down mt-1 max-h-24 overflow-auto">
            {importErrors.map((e, i) => <li key={i}>Line {e.line}: {e.message}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
