import { versionStatus, type DefMeta } from "../../lib/scanlab";
import { Btn, ROW } from "./ui";

export default function VersionsView({
  versions, canPromote, promoteHint, busy, onPromote, onRollback,
}: {
  versions: DefMeta[];
  canPromote: boolean;
  promoteHint: string | null;
  busy: boolean;
  onPromote: () => void;
  onRollback: (id: number) => void;
}) {
  const shown = versions.filter((v) => v.status !== "discarded");
  if (shown.length === 0) return <p className="dim px-3 pb-3 m-0">No versions yet.</p>;
  return (
    <div className="pb-3">
      {shown.map((v) => (
        <div key={v.id} className={`${ROW} grid-cols-[minmax(0,1fr)_auto] !py-2.5`}>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="font-semibold font-[family-name:var(--font-mono)]">{v.version}</span>
            <span className="dim text-[11.5px]">{versionStatus(v)}</span>
          </div>
          {v.status === "draft" && (
            <Btn disabled={!canPromote || busy} title={promoteHint ?? undefined} onClick={onPromote}>Promote</Btn>
          )}
          {v.status === "previous" && <Btn disabled={busy} onClick={() => onRollback(v.id)}>Roll back</Btn>}
        </div>
      ))}
    </div>
  );
}
