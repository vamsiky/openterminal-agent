import { useMemo, useState } from "react";
import { usedKeys, type CatalogField, type ScanKind } from "../../lib/scanlab";
import ErrorNote from "../ErrorNote";
import { H, ROW } from "./ui";
import { useCatalog } from "./queries";

export default function DataView({ kind, definition }: { kind: ScanKind; definition: unknown }) {
  const cat = useCatalog(kind);
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const fields = cat.data;
  const used = useMemo(() => (fields ? usedKeys(definition, fields.map((f) => f.key)) : new Set<string>()), [fields, definition]);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hits = (fields ?? []).filter((f) => !needle || [f.label, f.key, f.description, f.group].some((s) => s.toLowerCase().includes(needle)));
    const by = new Map<string, CatalogField[]>();
    for (const f of hits) by.set(f.group, [...(by.get(f.group) ?? []), f]);
    return [...by.entries()];
  }, [fields, q]);

  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  };

  if (cat.isLoading) return <p className="dim px-3 pb-3 m-0">Loading the data catalog…</p>;
  if (cat.error) return <ErrorNote error={cat.error} />;
  return (
    <div className="pb-3">
      <p className="dim text-[12px] mx-3 mb-2 leading-relaxed">
        Every field a definition can use. Click a key to copy it, then name it in your text. New data needs a code change.
      </p>
      <div className="px-3 pb-1">
        <input aria-label="Search fields" placeholder="Search fields" className="w-full" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {groups.length === 0 && <p className="dim px-3 py-2 m-0">No field matches “{q}”.</p>}
      {groups.map(([group, items]) => (
        <div key={group} className="mt-1.5">
          <div className={`${ROW} !border-t-0 pt-2.5`}><h3 className={H}>{group}</h3></div>
          {items.map((f) => (
            <div key={f.key} className={`${ROW} grid-cols-[minmax(0,1fr)]`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{f.label}</span>
                <button
                  className="font-[family-name:var(--font-mono)] text-[11px] dim hover:text-[var(--amber)]"
                  title="Copy key"
                  onClick={() => void copy(f.key)}
                >
                  {copied === f.key ? "copied" : f.key}
                </button>
                <span className="dim text-[10px]">{f.unit}</span>
                {used.has(f.key) && <span className="text-[10px] text-[#ffb84d] border border-[#6b4a14] rounded px-1">used</span>}
              </div>
              <div className="dim text-[11px]">{f.description} <span className="opacity-70">· {f.source}</span></div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
