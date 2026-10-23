import { useState } from "react";
import { Fragment } from "react";
import { fmt } from "../../lib/api";
import { barWidth, changesLine, ideaTag, mergeFunnel, mergeSpread, type Compare, type ResultIdea } from "../../lib/scanlab";
import { contractLabel, strategyLabel } from "../../lib/ideas";
import Segmented from "../ui/Segmented";
import { H, NOTE, ROW, Tag } from "./ui";

type Tab = "ideas" | "gates" | "spread";

function IdeaRow({ i, cols, tag, dim }: { i: ResultIdea; cols: string; tag?: { text: string; tone: "new" | "up" | "down" | "" }; dim?: boolean }) {
  return (
    <div className={`${ROW} ${cols} ${dim ? "opacity-60" : ""}`}>
      <span className="font-semibold font-[family-name:var(--font-mono)]">{i.symbol}</span>
      <span className="dim truncate" title={i.contract ? contractLabel(i.contract) : undefined}>{strategyLabel(i.strategy as never)}</span>
      <span className="text-right font-[family-name:var(--font-mono)]">{fmt(i.score, 1)}</span>
      {tag && <Tag tone={tag.tone}>{tag.text}</Tag>}
    </div>
  );
}

function IdeasCompare({ c, liveName, draftName }: { c: Compare; liveName: string; draftName: string }) {
  const near = c.draft.nearMisses ?? [];
  return (
    <>
      <div className="grid gap-3 grid-cols-1 @[560px]:grid-cols-2">
        <div className="border border-[var(--border)] rounded-md pb-1 min-w-0">
          <div className="px-3 py-2 flex justify-between"><span className={H}>Live · {liveName}</span><span className="dim">{(c.live.ideas ?? []).length}</span></div>
          {(c.live.ideas ?? []).map((i) => <IdeaRow key={`${i.symbol}:${i.strategy}`} i={i} cols="grid-cols-[56px_minmax(0,1fr)_44px]" />)}
          {(c.live.ideas ?? []).length === 0 && <p className="dim px-3 py-1 m-0">No ideas.</p>}
        </div>
        <div className="border border-[#6b4a14] rounded-md pb-1 min-w-0">
          <div className="px-3 py-2 flex justify-between"><span className={`${H} amber`}>Draft · {draftName}</span><span className="dim">{(c.draft.ideas ?? []).length}</span></div>
          {(c.draft.ideas ?? []).map((i) => (
            <IdeaRow key={`${i.symbol}:${i.strategy}`} i={i} cols="grid-cols-[56px_minmax(0,1fr)_44px_48px]" tag={ideaTag(i, c.added ?? [], c.rankChanges ?? [])} />
          ))}
          {(c.draft.ideas ?? []).length === 0 && <p className="dim px-3 py-1 m-0">No ideas.</p>}
          {near.length > 0 && (
            <>
              <div className="px-3 pt-2.5 pb-1"><span className={H}>Near misses · {near.length}</span></div>
              {near.map((i) => <IdeaRow key={`n:${i.symbol}:${i.strategy}`} i={i} cols="grid-cols-[56px_minmax(0,1fr)_44px_48px]" tag={{ text: "", tone: "" }} dim />)}
            </>
          )}
        </div>
      </div>
      <p className={`${NOTE} mt-1`}>{changesLine(c.added ?? [], c.removed ?? [])}</p>
    </>
  );
}

function Bars({ live, draft, max }: { live: number | null; draft: number | null; max: number }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="block h-2 rounded-sm bg-[#555]" style={{ width: `${barWidth(live ?? 0, max)}%` }} />
      <span className="block h-2 rounded-sm bg-[var(--amber)]" style={{ width: `${barWidth(draft ?? 0, max)}%` }} />
    </span>
  );
}

function Gates({ c }: { c: Compare }) {
  const rows = mergeFunnel(c.live.funnel, c.draft.funnel);
  const max = Math.max(1, ...rows.flatMap((r) => [r.live ?? 0, r.draft ?? 0]));
  return (
    <div className="border border-[var(--border)] rounded-md pb-1.5">
      <div className={`${ROW} grid-cols-[minmax(0,1.6fr)_44px_44px_minmax(40px,1fr)] !border-t-0`}>
        <span className={H}>Step</span><span className={`${H} text-right`}>Live</span><span className={`${H} text-right amber`}>Draft</span><span />
      </div>
      {rows.map((r) => (
        <div key={r.step} className={`${ROW} grid-cols-[minmax(0,1.6fr)_44px_44px_minmax(40px,1fr)]`}>
          <span>{r.step}</span>
          <span className="text-right dim font-[family-name:var(--font-mono)]">{r.live ?? "—"}</span>
          <span className={`text-right font-[family-name:var(--font-mono)] ${r.live !== r.draft ? "amber" : "dim"}`}>{r.draft ?? "—"}</span>
          <Bars live={r.live} draft={r.draft} max={max} />
        </div>
      ))}
      {rows.length === 0 && <p className="dim px-3 py-1 m-0">No steps recorded.</p>}
    </div>
  );
}

function Spread({ c }: { c: Compare }) {
  const rows = mergeSpread(c.live.spread, c.draft.spread);
  const max = Math.max(1, ...rows.flatMap((r) => [r.live, r.draft]));
  return (
    <div className="border border-[var(--border)] rounded-md pb-1.5">
      <div className={`${ROW} grid-cols-[84px_minmax(40px,1fr)_40px_40px] !border-t-0`}>
        <span className={H}>Score</span><span className={H}>Setups</span><span className={`${H} text-right`}>Live</span><span className={`${H} text-right amber`}>Draft</span>
      </div>
      {rows.map((r) => (
        <div key={r.bucket} className={`${ROW} grid-cols-[84px_minmax(40px,1fr)_40px_40px]`}>
          <span className="font-[family-name:var(--font-mono)]">{r.bucket}</span>
          <Bars live={r.live} draft={r.draft} max={max} />
          <span className="text-right dim font-[family-name:var(--font-mono)]">{r.live}</span>
          <span className={`text-right font-[family-name:var(--font-mono)] ${r.live !== r.draft ? "amber" : "dim"}`}>{r.draft}</span>
        </div>
      ))}
      {rows.length === 0 && <p className="dim px-3 py-1 m-0">No scores recorded.</p>}
    </div>
  );
}

export default function CompareView({ c, liveName, draftName }: { c: Compare; liveName: string; draftName: string }) {
  const [tab, setTab] = useState<Tab>("ideas");
  return (
    <Fragment>
      <Segmented
        ariaLabel="Compare"
        className="self-start"
        value={tab}
        onChange={(t) => setTab(t as Tab)}
        options={[{ id: "ideas", label: "Ideas" }, { id: "gates", label: "Gates" }, { id: "spread", label: "Score spread" }]}
      />
      {tab === "ideas" && <IdeasCompare c={c} liveName={liveName} draftName={draftName} />}
      {tab === "gates" && (
        <>
          <Gates c={c} />
          <p className={`${NOTE} dim`}>Bars: grey is live, amber is the draft.</p>
        </>
      )}
      {tab === "spread" && (
        <>
          <Spread c={c} />
          <p className={`${NOTE} dim`}>Setups per 5-point score bucket. Grey is live, amber is the draft.</p>
        </>
      )}
    </Fragment>
  );
}
