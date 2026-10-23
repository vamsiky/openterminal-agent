import { KIND_LABEL, type ScanKind } from "../../lib/scanlab";
import { Btn, H, NOTE } from "./ui";

export type BuildState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "failed"; message: string; refused?: boolean };

export default function TextView({
  kind, text, onText, edited, draftBuilt, build, onBuild, onDiscardEdits,
}: {
  kind: ScanKind;
  text: string;
  onText: (t: string) => void;
  edited: boolean;
  /** An open Claude draft already matches this text. */
  draftBuilt: boolean;
  build: BuildState;
  onBuild: () => void;
  onDiscardEdits: () => void;
}) {
  const running = build.phase === "running";
  return (
    <div className="px-3 pb-3 flex flex-col gap-2.5">
      <p className="dim text-[12px] leading-relaxed m-0">
        Written from the active definition, so it always matches what runs. Change it in plain words and build a draft. Claude only changes settings; it never edits code.
      </p>
      <label htmlFor={`scantext-${kind}`} className={H}>{KIND_LABEL[kind]} as text</label>
      <textarea
        id={`scantext-${kind}`}
        className="w-full min-h-[360px] bg-[#050505] text-[#e8e8e8] border border-[#2c2c2c] rounded-md p-3 text-[12px] leading-relaxed resize-y font-[family-name:var(--font-mono)] focus:outline-2 focus:outline-[var(--amber)] focus:-outline-offset-1"
        spellCheck={false}
        value={text}
        onChange={(e) => onText(e.target.value)}
      />
      <div className="flex gap-2 flex-wrap items-center">
        <Btn primary disabled={!edited || draftBuilt || running} onClick={onBuild}>
          {running ? "Building…" : draftBuilt ? "Draft built" : "Build draft with Claude"}
        </Btn>
        <Btn disabled={!edited || running} onClick={onDiscardEdits}>Discard edits</Btn>
      </div>
      {running && <p role="status" className={`${NOTE} amber`}>Claude is reading your text…</p>}
      {build.phase === "failed" && (
        <p role="alert" className={`${NOTE} ${build.refused ? "amber" : "down"}`}>
          {build.refused ? "Claude can't build that. " : ""}{build.message}
          {build.refused ? " Scan Lab only sells cash-secured puts and covered calls and buys calls; it never places orders." : ""}
        </p>
      )}
    </div>
  );
}
