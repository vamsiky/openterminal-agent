"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPost, ApiError } from "../../lib/api";
import {
  buildFailure, draftNotes, isEdited, isStale, KIND_LABEL, SCHEDULE, seedText,
  type DefMeta, type FormEdit, type ScanKind,
} from "../../lib/scanlab";
import ErrorNote from "../ErrorNote";
import PillTabs from "../ui/PillTabs";
import Segmented from "../ui/Segmented";
import DataView from "../scanlab/DataView";
import DraftCard from "../scanlab/DraftCard";
import SettingsView from "../scanlab/SettingsView";
import TextView, { type BuildState } from "../scanlab/TextView";
import VersionsView from "../scanlab/VersionsView";
import { useBuildJob, useDefs, useDefView } from "../scanlab/queries";

type View = "text" | "settings" | "versions" | "data";
type Promoted = { name: string; previous: DefMeta | null };

export default function ScanLabWidget() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<ScanKind>("option");
  const [view, setView] = useState<View>("text");
  const [texts, setTexts] = useState<Partial<Record<ScanKind, string>>>({});
  const [confirm, setConfirm] = useState(false);
  const [promoted, setPromoted] = useState<Promoted | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const defs = useDefs(kind);
  const active = defs.data?.active ?? null;
  const draft = defs.data?.draft ?? null;
  const activeView = useDefView(active?.id);
  const draftView = useDefView(draft?.id);

  const job = useBuildJob(jobId);
  const refreshAll = () => void qc.invalidateQueries({ queryKey: ["scanlab"] });

  const build = useMutation({
    mutationFn: (text: string) => apiPost<{ jobId: string }>("/api/scan/defs/build", { kind, baseId: active?.id, text }),
    onSuccess: (r) => setJobId(r.jobId),
  });
  const jobStatus = job.data?.status;
  useEffect(() => {
    if (jobStatus === "done") refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobStatus]);

  const saveForm = useMutation({
    mutationFn: (edits: FormEdit[]) => apiPost("/api/scan/defs/draft", { kind, baseId: active?.id, edits }),
    onSuccess: () => {
      setPromoted(null);
      refreshAll();
    },
  });
  const rollback = useMutation({
    mutationFn: (id: number) => apiPost(`/api/scan/defs/${id}/rollback`, {}),
    onSuccess: () => {
      setPromoted(null);
      refreshAll();
    },
  });

  const switchKind = (k: ScanKind) => {
    setKind(k);
    setConfirm(false);
    setPromoted(null);
    setJobId(null);
    build.reset();
    saveForm.reset();
  };

  const activeText = activeView.data?.text ?? "";
  const text = texts[kind] ?? seedText(activeText, draft);
  const edited = !!active && isEdited(text, activeText);
  const stale = isStale(text, draft);
  const draftBuilt = !!draft && draft.author === "claude" && !stale;

  const buildState: BuildState =
    build.isPending || jobStatus === "running" || (jobId !== null && !job.data && !job.error)
      ? { phase: "running" }
      : build.error
        ? { phase: "failed", message: buildFailure(build.error instanceof ApiError ? build.error.status : undefined, build.error.message).message }
        : jobStatus === "error"
          ? { phase: "failed", message: job.data?.error ?? "Claude couldn't build a draft from that text." }
          : job.error
            ? { phase: "failed", message: `Lost track of the build: ${job.error.message}` }
            : { phase: "idle" };

  const saved = draftNotes(draftView.data?.meta ?? draft);
  const fromJob = job.data?.status === "done" && draft && job.data.draftId === draft.id;
  const notes = fromJob && job.data?.notes ? job.data.notes : saved.notes;
  const needsCode = fromJob && job.data?.needsCode ? job.data.needsCode : saved.needsCode;

  const draftTested = !!draftView.data?.tests?.replay;
  const promoteHint = !draftTested ? "Run a replay test first" : stale ? "Build again first" : null;

  return (
    <div className="@container flex flex-col h-full w-full min-w-0 overflow-auto text-[11px]">
      <div className="flex flex-col gap-3 p-2">
        <section className="border border-[var(--border)] rounded-md bg-[var(--panel)] px-3 py-2.5 flex items-center gap-x-3 gap-y-2 flex-wrap">
          <h1 className="m-0 text-[14px] font-semibold">Scan Lab</h1>
          <PillTabs
            ariaLabel="Scan"
            value={kind}
            onChange={(k) => switchKind(k as ScanKind)}
            tabs={(["stock", "option"] as const).map((k) => ({ id: k, label: KIND_LABEL[k] }))}
          />
          <span className="flex-1" />
          {active && (
            <span className="border border-[#333] rounded-md px-2 py-1 text-[11px] font-[family-name:var(--font-mono)]">
              Active: <span className="amber">{active.version}</span>
            </span>
          )}
          <span className="dim text-[11px]">{SCHEDULE[kind]}</span>
        </section>

        {defs.isLoading ? (
          <p className="dim p-1 m-0">Loading Scan Lab…</p>
        ) : defs.error ? (
          <ErrorNote error={defs.error} />
        ) : !active ? (
          <p className="dim p-1 m-0">No active {KIND_LABEL[kind].toLowerCase()} definition yet.</p>
        ) : (
          <div className="grid grid-cols-1 @[860px]:grid-cols-2 gap-3 items-start">
            <section className="border border-[var(--border)] rounded-md bg-[var(--panel)] min-w-0" aria-label="Definition">
              <div className="flex justify-between items-center px-3 py-2.5 gap-2 flex-wrap">
                <Segmented
                  ariaLabel="View"
                  value={view}
                  onChange={(v) => setView(v as View)}
                  options={[{ id: "text", label: "Text" }, { id: "settings", label: "Settings" }, { id: "versions", label: "Versions" }, { id: "data", label: "Data available" }]}
                />
                <span className="dim text-[12px]">{edited ? "Edited · not active" : `Matches ${active.version}`}</span>
              </div>
              {activeView.isLoading ? (
                <p className="dim px-3 pb-3 m-0">Loading {active.version}…</p>
              ) : activeView.error ? (
                <ErrorNote error={activeView.error} />
              ) : view === "text" ? (
                <TextView
                  kind={kind}
                  text={text}
                  onText={(t) => setTexts((x) => ({ ...x, [kind]: t }))}
                  edited={edited}
                  draftBuilt={draftBuilt}
                  build={buildState}
                  onBuild={() => { setJobId(null); build.mutate(text); }}
                  onDiscardEdits={() => setTexts((x) => ({ ...x, [kind]: activeText }))}
                />
              ) : view === "settings" ? (
                <SettingsView
                  key={`${kind}-${draft?.id ?? "none"}`}
                  kind={kind}
                  active={activeView.data?.form ?? []}
                  draft={draftView.data?.form ?? null}
                  hasDraft={!!draft}
                  saving={saveForm.isPending}
                  error={saveForm.error ? saveForm.error.message : null}
                  onSave={(edits) => saveForm.mutate(edits)}
                />
              ) : view === "versions" ? (
                <VersionsView
                  versions={defs.data?.versions ?? []}
                  canPromote={draftTested && !stale}
                  promoteHint={promoteHint}
                  busy={rollback.isPending}
                  onPromote={() => setConfirm(true)}
                  onRollback={(id) => rollback.mutate(id)}
                />
              ) : (
                <DataView kind={kind} definition={activeView.data?.definition} />
              )}
              {rollback.error != null && <p role="alert" className="down text-[12px] px-3 pb-3 m-0">{rollback.error.message}</p>}
            </section>

            <DraftCard
              key={kind}
              kind={kind}
              active={active}
              draft={draft}
              view={draftView.data}
              loading={draftView.isLoading}
              error={draftView.error}
              notes={notes}
              needsCode={needsCode}
              stale={stale}
              confirm={confirm && !!draft}
              onConfirm={setConfirm}
              onPromoted={(p, prev) => setPromoted({ name: p.version, previous: prev })}
              promotedMessage={promoted && !draft ? `${promoted.name} is active. Ideas use it from the next pass.` : null}
              onRollback={promoted?.previous ? () => rollback.mutate(promoted.previous!.id) : null}
              rollbackName={promoted?.previous?.version ?? null}
            />
          </div>
        )}
      </div>
    </div>
  );
}
