import { useMemo, useState } from "react";
import {
  formatItem, formEdits, inputValue, inRange, parseInput, rangeHint,
  type FormItem, type FormSection, type LeafValue, type ScanKind,
} from "../../lib/scanlab";
import { Btn, H, ROW } from "./ui";

const COLS = "grid-cols-[minmax(0,1fr)_64px_92px]";

export default function SettingsView({
  kind, active, draft, hasDraft, saving, error, onSave,
}: {
  kind: ScanKind;
  active: FormSection[];
  /** The open draft's form, when there is one: it is what the Draft column starts from. */
  draft: FormSection[] | null;
  hasDraft: boolean;
  saving: boolean;
  error: string | null;
  onSave: (edits: ReturnType<typeof formEdits>) => void;
}) {
  const [typed, setTyped] = useState<Record<string, string>>({});
  const activeBy = useMemo(() => new Map(active.flatMap((s) => s.items).map((i) => [i.path, i])), [active]);
  const base = draft ?? active;
  const baseBy = useMemo(() => new Map(base.flatMap((s) => s.items).map((i) => [i.path, i.value])), [base]);

  /** Parsed value of what is in the box, or the draft's value when untouched. */
  const current = (it: FormItem): LeafValue | undefined => (it.path in typed ? parseInput(it, typed[it.path]) : baseBy.get(it.path));
  const changedFromActive = (it: FormItem) => {
    const a = activeBy.get(it.path);
    return !!a && JSON.stringify(current(it)) !== JSON.stringify(a.value);
  };
  const invalid = (it: FormItem) => it.path in typed && (current(it) === undefined || !inRange(it, current(it) as LeafValue));

  const merged: Record<string, LeafValue> = {};
  let anyInvalid = false;
  for (const s of base) {
    for (const it of s.items) {
      const v = current(it);
      if (v === undefined) anyInvalid = true;
      else merged[it.path] = v;
      if (invalid(it)) anyInvalid = true;
    }
  }
  const edits = formEdits(active, merged);
  const dirty = edits.length > 0 && Object.keys(typed).length > 0;

  return (
    <div className="pb-3">
      <p className="dim text-[12px] mx-3 mb-2 leading-relaxed">
        The same definition as a form. Changing a number makes a draft directly, with no Claude call. Each field only accepts its allowed range.
        {hasDraft && " Saving replaces the open draft."}
      </p>
      {base.map((s) => (
        <div key={s.section} className="mt-1.5">
          <div className={`${ROW} ${COLS} !border-t-0 pt-2.5`}>
            <h3 className={H}>{s.section}</h3>
            <span className={`${H} text-right`}>Active</span>
            <span className={H}>Draft</span>
          </div>
          {s.items.map((it) => {
            const id = `f-${kind}-${it.path}`;
            const a = activeBy.get(it.path);
            const changed = changedFromActive(it);
            const hint = rangeHint(it);
            return (
              <div key={it.path} className={`${ROW} ${COLS} ${it.readOnly ? "opacity-70" : ""}`}>
                <div className="min-w-0">
                  <label htmlFor={id} className="break-words">{it.label}</label>
                  {it.readOnly && it.note && <div className="dim text-[10.5px]">{it.note}</div>}
                  {!it.readOnly && hint && <div className="dim text-[10px]">{hint}</div>}
                </div>
                <span className="text-right dim font-[family-name:var(--font-mono)]">{a ? formatItem(a) : "—"}</span>
                {it.readOnly ? (
                  <span id={id} className="dim font-[family-name:var(--font-mono)]">{formatItem(it)}</span>
                ) : it.type === "boolean" ? (
                  <input
                    id={id}
                    type="checkbox"
                    className="justify-self-start"
                    checked={current(it) === true}
                    onChange={(e) => setTyped((t) => ({ ...t, [it.path]: String(e.target.checked) }))}
                  />
                ) : it.type === "choice" ? (
                  <select id={id} value={String(current(it) ?? "")} onChange={(e) => setTyped((t) => ({ ...t, [it.path]: e.target.value }))}>
                    {(it.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input
                    id={id}
                    inputMode="decimal"
                    className={`w-full font-[family-name:var(--font-mono)] ${changed ? "!border-[var(--amber)] amber" : ""} ${invalid(it) ? "!border-[var(--down)]" : ""}`}
                    placeholder={it.value === null ? "off" : undefined}
                    value={it.path in typed ? typed[it.path] : inputValue(it, baseBy.get(it.path) ?? null)}
                    aria-invalid={invalid(it) || undefined}
                    onChange={(e) => setTyped((t) => ({ ...t, [it.path]: e.target.value }))}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div className="px-3 pt-3 flex gap-2 items-center flex-wrap">
        <Btn primary disabled={!dirty || anyInvalid || saving} onClick={() => onSave(edits)}>{saving ? "Saving…" : "Save as draft"}</Btn>
        <Btn disabled={Object.keys(typed).length === 0} onClick={() => setTyped({})}>Reset</Btn>
        {anyInvalid && <span className="down text-[11px]">A value is outside its range.</span>}
      </div>
      {error && <p role="alert" className="down text-[12px] px-3 pt-2 m-0">{error}</p>}
    </div>
  );
}
