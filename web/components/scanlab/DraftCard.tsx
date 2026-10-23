import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPost } from "../../lib/api";
import {
  DIFF_TAG, onlyInDraft, passTime, type DefMeta, type DefView, type DiffRow, type NeedsCode, type ScanKind,
} from "../../lib/scanlab";
import Segmented from "../ui/Segmented";
import ErrorNote from "../ErrorNote";
import CompareView from "./CompareView";
import { useCompare } from "./queries";
import { Btn, H, NOTE, ROW, Tag } from "./ui";

type Mode = "replay" | "shadow";
const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

function Diff({ rows }: { rows: DiffRow[] }) {
  return (
    <div>
      <h3 className={`${H} px-3 pb-1.5`}>What changes</h3>
      <div className={`${ROW} grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_64px] !border-t-0`}>
        <span className={H}>Setting</span><span className={H}>Active</span><span className={H}>Draft</span><span />
      </div>
      {rows.map((d) => (
        <div key={d.path + d.label} className={`${ROW} grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_64px]`}>
          <span className="break-words">{d.label}</span>
          <span className="dim font-[family-name:var(--font-mono)] break-words">{d.from ?? "none"}</span>
          <span className="amber font-[family-name:var(--font-mono)] break-words">{d.to ?? "removed"}</span>
          <Tag tone={DIFF_TAG[d.change].tone}>{DIFF_TAG[d.change].text}</Tag>
        </div>
      ))}
      {rows.length === 0 && <p className="dim px-3 py-1 m-0">No setting differs from the active version.</p>}
    </div>
  );
}

export default function DraftCard({
  kind, active, draft, view, loading, error, notes, needsCode, stale, confirm, onConfirm, onPromoted, promotedMessage, onRollback, rollbackName,
}: {
  kind: ScanKind;
  active: DefMeta | null;
  draft: DefMeta | null;
  view: DefView | undefined;
  loading: boolean;
  error: unknown;
  notes: string[];
  needsCode: NeedsCode[];
  stale: boolean;
  confirm: boolean;
  onConfirm: (open: boolean) => void;
  onPromoted: (promoted: DefMeta, previous: DefMeta | null) => void;
  promotedMessage: string | null;
  onRollback: (() => void) | null;
  rollbackName: string | null;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("replay");
  const [requested, setRequested] = useState<Record<number, "sent" | string>>({});
  const id = draft?.id ?? null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["scanlab"] });
  };

  const replay = useMutation({
    mutationFn: () => apiPost(`/api/scan/defs/${id}/replay`, { source: "latest" }),
    onSuccess: refresh,
  });
  const shadow = useMutation({
    mutationFn: (on: boolean) => apiPost(`/api/scan/defs/${id}/shadow`, { on }),
    onSuccess: refresh,
  });
  const promote = useMutation({
    mutationFn: () => apiPost(`/api/scan/defs/${id}/promote`, {}),
    onSuccess: () => {
      onConfirm(false);
      if (draft) onPromoted(draft, active);
      refresh();
    },
  });
  const discard = useMutation({
    mutationFn: () => apiPost(`/api/scan/defs/${id}/discard`, {}),
    onSuccess: refresh,
  });

  const tests = view?.tests;
  const hasReplay = !!tests?.replay;
  const shadowOn = tests?.shadow?.on === true;
  const passes = tests?.shadow?.passes ?? [];
  const compareReplay = useCompare(id, "replay", mode === "replay" && hasReplay);
  const compareShadow = useCompare(id, "shadow", mode === "shadow" && passes.length > 0);
  const cmp = mode === "replay" ? compareReplay : compareShadow;
  const cmpData = cmp.data?.live && cmp.data.draft ? cmp.data : null;
  const canPromote = hasReplay && !stale;

  const requestCode = async (n: NeedsCode, i: number) => {
    setRequested((r) => ({ ...r, [i]: "sending" }));
    try {
      await apiPost("/api/scan/code-requests", { kind, draftId: id, request: n.request, reason: n.reason });
      setRequested((r) => ({ ...r, [i]: "sent" }));
    } catch (e) {
      setRequested((r) => ({ ...r, [i]: `Couldn't send: ${errText(e)}` }));
    }
  };

  const status = !draft ? "" : stale ? "out of date" : hasReplay ? "tested by replay" : "not tested yet";

  return (
    <section className="border border-[var(--border)] rounded-md bg-[var(--panel)] min-w-0 pb-3.5" aria-label="Draft">
      <div className="flex items-center gap-2.5 px-3.5 py-3 flex-wrap">
        <h2 className={`${H} !text-[12px]`}>Draft</h2>
        <span className="amber font-[family-name:var(--font-mono)] text-[13px]">{draft?.version ?? "—"}</span>
        <span className="dim text-[12px]">{status}</span>
      </div>

      {promotedMessage && (
        <div className="mx-3.5 mb-3 border border-[#1f5e37] bg-[#06150c] rounded-md px-3.5 py-3 flex gap-3 items-center flex-wrap" role="status">
          <span className="up font-semibold text-[12.5px]">{promotedMessage}</span>
          <span className="flex-1" />
          {onRollback && rollbackName && <Btn onClick={onRollback}>Roll back to {rollbackName}</Btn>}
        </div>
      )}

      {!draft && (
        <div className="mx-3.5 border border-dashed border-[#333] rounded-md p-5 flex flex-col gap-2">
          <p className={NOTE}>No draft yet. Edit the text on the left and build a draft, or change a number in Settings.</p>
          <p className={`${NOTE} dim`}>A draft is tested on its own. Your Ideas list doesn&apos;t change until you promote it.</p>
        </div>
      )}

      {draft && loading && <p className="dim px-3.5 m-0">Loading the draft…</p>}
      {draft && error != null && <ErrorNote error={error} />}

      {draft && view && (
        <div className="flex flex-col gap-4">
          {stale && <p className={`${NOTE} amber mx-3.5 m-0`}>The text changed after this draft was built. Build again to update it.</p>}
          <Diff rows={view.diff} />

          {(notes.length > 0 || needsCode.length > 0) && (
            <div className="px-3.5 flex flex-col gap-2">
              <h3 className={H}>Claude&apos;s notes</h3>
              {notes.map((n, i) => <p key={i} className={`${NOTE} m-0`}>{n}</p>)}
              {needsCode.map((n, i) => (
                <div key={`c${i}`} className="flex gap-2.5 items-start flex-wrap">
                  <p className={`${NOTE} m-0 flex-1 basis-[240px]`}>{n.request}{n.reason ? ` ${n.reason}` : ""}</p>
                  {requested[i] === "sent" ? (
                    <span className="up text-[12px]">Requested</span>
                  ) : (
                    <Btn disabled={requested[i] === "sending"} onClick={() => void requestCode(n, i)}>Request as a code change</Btn>
                  )}
                  {requested[i] && requested[i] !== "sent" && requested[i] !== "sending" && <span role="alert" className="down text-[11px] basis-full">{requested[i]}</span>}
                </div>
              ))}
            </div>
          )}

          <div className="px-3.5 flex flex-col gap-2.5">
            <div className="flex gap-2.5 items-center flex-wrap">
              <h3 className={H}>Test</h3>
              <Segmented ariaLabel="Test mode" value={mode} onChange={(m) => setMode(m as Mode)} options={[{ id: "replay", label: "Replay latest inputs" }, { id: "shadow", label: "Live shadow" }]} />
            </div>

            {mode === "replay" && (
              <>
                <div className="flex gap-2 items-center flex-wrap">
                  <Btn disabled={replay.isPending} onClick={() => replay.mutate()}>{replay.isPending ? "Replaying…" : hasReplay ? "Replay again" : "Run replay"}</Btn>
                  {compareReplay.data?.draft && (
                    <span className="dim text-[12px]">
                      Replayed {compareReplay.data.draft.scanned} {kind === "option" ? "underlyings" : "stocks"} from the pass at {passTime(compareReplay.data.draft.at)} ET.
                    </span>
                  )}
                </div>
                {replay.error != null && <p role="alert" className="down text-[12px] m-0">{errText(replay.error)}</p>}
              </>
            )}

            {mode === "shadow" && (
              <div className="border border-[#2c2c2c] rounded-md p-3 flex flex-col gap-2.5">
                <p className={`${NOTE} m-0`}>
                  Live shadow scores the draft next to the live scan on every {kind === "option" ? "5-minute" : "15-minute"} pass in market hours.
                </p>
                <div className="flex gap-2 items-center flex-wrap">
                  <Btn disabled={shadow.isPending} onClick={() => shadow.mutate(!shadowOn)}>{shadowOn ? "Stop live shadow" : "Start live shadow"}</Btn>
                  <span className="dim text-[12px]">Nothing from the shadow run reaches your Ideas list.</span>
                </div>
                {shadow.error != null && <p role="alert" className="down text-[12px] m-0">{errText(shadow.error)}</p>}
                <div className={`${ROW} grid-cols-[64px_1fr_1fr_1fr] border-t border-[var(--border)]`}>
                  <span className={H}>Pass</span><span className={H}>Live ideas</span><span className={H}>Draft ideas</span><span className={H}>Only in draft</span>
                </div>
                {passes.length === 0 && <p className="dim m-0 px-3">No passes yet.</p>}
                {passes.map((p) => (
                  <div key={p.at} className={`${ROW} grid-cols-[64px_1fr_1fr_1fr]`}>
                    <span className="font-[family-name:var(--font-mono)]">{passTime(p.at)}</span>
                    <span className="font-[family-name:var(--font-mono)]">{p.live.ideas.length}</span>
                    <span className="font-[family-name:var(--font-mono)]">{p.draft.ideas.length}</span>
                    <span className="font-[family-name:var(--font-mono)] amber">{onlyInDraft(p)}</span>
                  </div>
                ))}
              </div>
            )}

            {cmp.isLoading && cmp.fetchStatus !== "idle" && <p className="dim m-0">Loading the comparison…</p>}
            {cmp.error != null && <ErrorNote error={cmp.error} />}
            {cmpData && <CompareView c={cmpData} liveName={active?.version ?? "live"} draftName={draft.version} />}
            {mode === "replay" && !hasReplay && !replay.isPending && <p className={`${NOTE} dim m-0`}>Run a replay to compare this draft with live. Promote needs one.</p>}
          </div>

          <div className="px-3.5 flex gap-2 flex-wrap items-center">
            <Btn primary disabled={!canPromote || confirm || promote.isPending} title={!hasReplay ? "Run a replay test first" : stale ? "Build again first" : undefined} onClick={() => onConfirm(true)}>Promote to active</Btn>
            <Btn disabled={discard.isPending} onClick={() => discard.mutate()}>Discard draft</Btn>
            {discard.error != null && <span role="alert" className="down text-[12px]">{errText(discard.error)}</span>}
          </div>

          {confirm && (
            <div className="mx-3.5 border border-[var(--amber)] rounded-md p-3.5 flex flex-col gap-2.5 bg-[#140e03]" role="alertdialog" aria-label="Confirm promote">
              <p className={`${NOTE} m-0`}>
                Make {draft.version} the active {kind === "option" ? "options" : "stock"} scan? Ideas use it from the next pass.
                {active ? ` ${active.version} stays in Versions, so you can roll back with one click.` : ""}
              </p>
              <div className="flex gap-2 flex-wrap">
                <Btn primary disabled={promote.isPending} onClick={() => promote.mutate()}>Make {draft.version} active</Btn>
                <Btn onClick={() => onConfirm(false)}>Cancel</Btn>
              </div>
              {promote.error != null && <p role="alert" className="down text-[12px] m-0">{errText(promote.error)}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

