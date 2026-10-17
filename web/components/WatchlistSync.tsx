"use client";

import { useEffect } from "react";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { listPath, WATCHLISTS_CHANGED } from "../lib/watchlist";
import { useTerminal, type Watchlist } from "../store/terminal";

const SAVE_DELAY_MS = 500;
const RETRY_MS = 10_000;

/**
 * Keeps the watchlists on the server, where agents and the history sync can
 * see them. On load the server copy wins, except for lists this browser has
 * changed or deleted and the server hasn't stored yet (edits made before the
 * load finished, or while the API was unreachable); if the server has no lists
 * yet, this browser's lists seed it. Failed saves are retried, pending saves
 * are flushed when the tab closes, and a tab coming back into view (or an
 * import) picks up changes made elsewhere. localStorage stays as a cache, so
 * the terminal still works if the API is down.
 */
export default function WatchlistSync() {
  useEffect(() => {
    let stopped = false;
    let applying = false; // true while writing the server copy into the store
    // Lists the server hasn't stored yet: symbols to save, or null to delete.
    const unsaved = new Map<string, string[] | null>();
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;

    const apply = (lists: Watchlist[]) => {
      applying = true;
      useTerminal.getState().setWatchlists(lists);
      applying = false;
    };

    const send = (name: string, symbols: string[] | null) =>
      symbols === null ? apiDelete(listPath(name)) : apiPost(listPath(name), { symbols });

    const save = (delay = SAVE_DELAY_MS) => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (stopped) return;
        for (const [name, symbols] of unsaved) {
          send(name, symbols)
            .then(() => {
              if (unsaved.get(name) === symbols) unsaved.delete(name);
            })
            .catch(() => {
              if (!stopped) save(RETRY_MS);
            });
        }
      }, delay);
    };

    const load = () => {
      clearTimeout(loadTimer);
      apiGet<Watchlist[]>("/api/watchlists")
        .then((server) => {
          if (stopped) return;
          if (server.length === 0) {
            for (const l of useTerminal.getState().watchlists) unsaved.set(l.name, l.symbols);
            save(0);
            return;
          }
          // Server lists, with this browser's unsaved edits and new lists on top.
          const lists = server
            .filter((l) => unsaved.get(l.name) !== null)
            .map((l) => ({ name: l.name, symbols: unsaved.get(l.name) ?? l.symbols }));
          for (const [name, symbols] of unsaved) {
            if (symbols && !lists.some((l) => l.name === name)) lists.push({ name, symbols });
          }
          apply(lists);
          if (unsaved.size) save(0);
        })
        .catch(() => {
          // API unreachable: keep the local lists and try again shortly.
          if (!stopped) loadTimer = setTimeout(load, RETRY_MS);
        });
    };

    const unsubscribe = useTerminal.subscribe((state, prev) => {
      if (applying || state.watchlists === prev.watchlists) return;
      for (const l of state.watchlists) {
        const before = prev.watchlists.find((p) => p.name === l.name);
        if (!before || before.symbols !== l.symbols) unsaved.set(l.name, l.symbols);
      }
      for (const p of prev.watchlists) {
        if (!state.watchlists.some((l) => l.name === p.name)) unsaved.set(p.name, null);
      }
      save();
    });

    // Closing the tab cancels timers, so send pending saves right away.
    const flush = () => {
      clearTimeout(saveTimer);
      for (const [name, symbols] of unsaved) {
        fetch(listPath(name), {
          method: symbols === null ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: symbols === null ? undefined : JSON.stringify({ symbols }),
          keepalive: true,
        }).catch(() => {});
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
      else load();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener(WATCHLISTS_CHANGED, load);
    document.addEventListener("visibilitychange", onVisibility);

    load();

    return () => {
      flush();
      stopped = true;
      clearTimeout(saveTimer);
      clearTimeout(loadTimer);
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener(WATCHLISTS_CHANGED, load);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
