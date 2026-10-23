"use client";

import { useEffect, useMemo, useState } from "react";
import { useTerminal, type WidgetType } from "../../store/terminal";
import { GROUPS, WIDGETS } from "./registry";

const ico = (d: string, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const RESET_ICON = "M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.5h2.5";

function useOpenCounts() {
  const panes = useTerminal((s) => s.panes);
  const windows = useTerminal((s) => s.windows);
  return useMemo(() => {
    const counts: Partial<Record<WidgetType, number>> = {};
    for (const t of [...panes.flatMap((p) => p.tabs), ...windows]) counts[t.type] = (counts[t.type] ?? 0) + 1;
    return counts;
  }, [panes, windows]);
}

function useFocusLabel() {
  return useTerminal((s) => {
    const pane = s.panes.find((p) => p.id === s.focusedPane);
    const tab = pane?.tabs.find((t) => t.id === pane.activeTab);
    return tab ? `${WIDGETS[tab.type]?.label ?? tab.type} pane` : "a new pane";
  });
}

function AddMenu({ type, focusLabel, done, role }: { type: WidgetType; focusLabel: string; done: () => void; role?: "menuitem" }) {
  const addTab = useTerminal((s) => s.addTab);
  const addPane = useTerminal((s) => s.addPane);
  const addWindow = useTerminal((s) => s.addWindow);
  const items: Array<[string, string, () => void]> = [
    [`Add as a tab in ${focusLabel}`, "M2 5h12v8H2zM2 5V3h5v2", () => addTab(type)],
    ["New pane to the right", "M2 2.5h12v11H2zM8 2.5v11", () => addPane(type, "right")],
    ["New pane below", "M2 2.5h12v11H2zM2 8h12", () => addPane(type, "below")],
    ["Open in its own window", "M9 2h5v5M14 2 8 8M12 9.5V14H2V4h4.5", () => addWindow(type)],
  ];
  return (
    <>
      {items.map(([label, path, run]) => (
        <button key={label} role={role} className="popt" onClick={() => { run(); done(); }}>
          {ico(path)}
          <span>{label}</span>
        </button>
      ))}
    </>
  );
}

export default function Rail() {
  const railOpen = useTerminal((s) => s.railOpen);
  const setRailOpen = useTerminal((s) => s.setRailOpen);
  const resetWorkspace = useTerminal((s) => s.resetWorkspace);
  const counts = useOpenCounts();
  const focusLabel = useFocusLabel();
  const [openRow, setOpenRow] = useState<WidgetType | null>(null);
  const [fly, setFly] = useState<{ type: WidgetType; top: number; left: number } | null>(null);

  useEffect(() => {
    if (!fly) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFly(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fly]);

  const toggleRail = () => {
    setFly(null);
    setOpenRow(null);
    setRailOpen(!railOpen);
  };
  const toggleLabel = railOpen ? "Collapse panels" : "Expand panels";

  return (
    <>
      <nav
        aria-label="Panels"
        className="flex-none flex flex-col overflow-y-auto bg-[#0c0c0d] border-r border-[#222]"
        style={{ width: railOpen ? 236 : 56, fontFamily: "var(--font-sans)" }}
      >
        <div className="flex items-center flex-none" style={{ justifyContent: railOpen ? "space-between" : "center", padding: railOpen ? "10px 10px 6px 14px" : "10px 0 6px" }}>
          {railOpen && <span className="text-[15px] font-semibold text-[#ededed]">Panels</span>}
          <button className="ico !w-[30px]" aria-label={toggleLabel} title={toggleLabel} onClick={toggleRail}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 2.5h12v11H2zM6 2.5v11" />
              <path d={railOpen ? "M11 6 9 8l2 2" : "M9 6l2 2-2 2"} />
            </svg>
          </button>
        </div>

        {railOpen ? (
          <>
            <p className="m-0 px-3.5 pb-1.5 text-[12px] leading-snug text-[#9a9a9a]">
              Pick a panel to add it. Selected pane: <span className="text-[var(--amber-hi)]">{focusLabel}</span>
            </p>
            {GROUPS.map((g) => (
              <div key={g.name}>
                <div className="px-3.5 pt-3 pb-1 text-[11px] font-medium text-[#8f8f8f]">{g.name}</div>
                {g.types.map((type) => {
                  const def = WIDGETS[type];
                  const n = counts[type] ?? 0;
                  const open = openRow === type;
                  return (
                    <div key={type} className="px-2">
                      <button className={`pitem ${open ? "on" : ""}`} aria-expanded={open} onClick={() => setOpenRow(open ? null : type)}>
                        <span className="picon">{ico(def.icon, 16)}</span>
                        <span className="flex-1 text-left">{def.label}</span>
                        {n > 0 && <span className="pcount">{n} open</span>}
                      </button>
                      {open && (
                        <div className="pmenu">
                          <AddMenu type={type} focusLabel={focusLabel} done={() => setOpenRow(null)} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            <div className="px-2 pt-3.5 pb-3 mt-auto">
              <button className="popt !text-[#9a9a9a]" onClick={resetWorkspace}>
                {ico(RESET_ICON)}
                <span>Reset layout</span>
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-col flex-1 pb-2">
            {GROUPS.map((g, gi) => (
              <div key={g.name} className="flex flex-col">
                <div className={`rsep ${gi === 0 ? "first" : ""}`} role="separator" aria-label={g.name} />
                {g.types.map((type) => {
                  const def = WIDGETS[type];
                  const n = counts[type] ?? 0;
                  const tip = def.label + (n ? ` · ${n} open` : "");
                  return (
                    <button
                      key={type}
                      className={`picon-btn ${fly?.type === type ? "on" : ""}`}
                      aria-label={tip}
                      title={tip}
                      aria-expanded={fly?.type === type}
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setFly(fly?.type === type ? null : { type, top: Math.min(r.top, window.innerHeight - 230), left: r.right + 10 });
                      }}
                    >
                      {ico(def.icon, 16)}
                      {n > 0 && <span className="pbadge">{n}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            <button className="picon-btn !text-[#8a8a8a] mt-auto" aria-label="Reset layout" title="Reset layout" onClick={resetWorkspace}>
              {ico(RESET_ICON, 16)}
            </button>
          </div>
        )}
      </nav>
      {!railOpen && fly && (
        <>
          <div className="fixed inset-0 z-[999]" onClick={() => setFly(null)} />
          <div className="pfly" role="menu" aria-label={`Add ${WIDGETS[fly.type].label}`} style={{ top: fly.top, left: fly.left }}>
            <div className="pfly-h">
              <span className="picon !w-6 !h-6">{ico(WIDGETS[fly.type].icon)}</span>
              <span className="flex-1">{WIDGETS[fly.type].label}</span>
              {(counts[fly.type] ?? 0) > 0 && <span className="pcount">{counts[fly.type]} open</span>}
            </div>
            <AddMenu type={fly.type} focusLabel={focusLabel} role="menuitem" done={() => setFly(null)} />
          </div>
        </>
      )}
    </>
  );
}
