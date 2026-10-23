"use client";

import { useEffect } from "react";
import TopBar from "./TopBar";
import Rail from "./workspace/Rail";
import { SHORTCUTS } from "./workspace/registry";
import Workspace from "./Workspace";
import WatchlistContainer from "./WatchlistContainer";
import CommandPalette from "./CommandPalette";
import WatchlistSync from "./WatchlistSync";
import { useTerminal } from "../store/terminal";
import { staleWindowIds } from "../lib/windows";

export default function Terminal() {
  const setCommandOpen = useTerminal((s) => s.setCommandOpen);
  const addTab = useTerminal((s) => s.addTab);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (e.altKey) {
        // e.code: on macOS Option+1 types "¡", so e.key would not match.
        const type = SHORTCUTS[e.code.replace("Digit", "")];
        if (type) {
          e.preventDefault();
          addTab(type);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCommandOpen, addTab]);

  // Dock widgets whose window is gone (closed without a pagehide, browser restart).
  useEffect(() => {
    const prune = () => {
      const { windows, dockWindow } = useTerminal.getState();
      staleWindowIds(windows.map((w) => w.id)).forEach(dockWindow);
    };
    prune();
    const t = setInterval(prune, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex flex-col h-screen">
      <TopBar />
      <div className="flex flex-1 min-h-0">
        <Rail />
        <WatchlistContainer />
        <main className="flex-1 min-w-0 relative">
          <div className="absolute inset-[2px]">
            <Workspace />
          </div>
        </main>
      </div>
      <CommandPalette />
      <WatchlistSync />
    </div>
  );
}
