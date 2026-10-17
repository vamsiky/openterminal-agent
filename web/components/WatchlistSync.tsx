"use client";

import { useEffect } from "react";
import { apiGet, apiPost } from "../lib/api";
import { useTerminal } from "../store/terminal";

type ServerWatchlist = { name: string; symbols: string[] | null };

const PATH = "/api/watchlists/default";
const SAVE_DELAY_MS = 500;
const RETRY_MS = 10_000;

/**
 * Keeps the watchlist on the server, where agents and the history sync can
 * see it. On load the server copy wins, unless this browser has edits the
 * server hasn't seen (made before the load finished, or while the API was
 * unreachable); if the server has no list yet, this browser's list seeds it.
 * Failed saves are retried, a pending save is flushed when the tab closes,
 * and a tab coming back into view picks up changes made elsewhere.
 * localStorage stays as a cache, so the terminal still works if the API is down.
 */
export default function WatchlistSync() {
  useEffect(() => {
    let stopped = false;
    let applying = false; // true while writing the server copy into the store
    let unsaved: string[] | null = null; // local list the server hasn't stored yet
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;

    const apply = (symbols: string[]) => {
      applying = true;
      useTerminal.getState().setWatchlist(symbols);
      applying = false;
    };

    const save = (delay = SAVE_DELAY_MS) => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const symbols = unsaved;
        if (!symbols || stopped) return;
        apiPost(PATH, { symbols })
          .then(() => {
            if (unsaved === symbols) unsaved = null;
          })
          .catch(() => {
            if (!stopped) save(RETRY_MS);
          });
      }, delay);
    };

    const load = () => {
      clearTimeout(loadTimer);
      apiGet<ServerWatchlist>(PATH)
        .then((server) => {
          if (stopped) return;
          if (unsaved || server.symbols === null) {
            unsaved = unsaved ?? useTerminal.getState().watchlist;
            save(0);
          } else {
            apply(server.symbols);
          }
        })
        .catch(() => {
          // API unreachable: keep the local list and try again shortly.
          if (!stopped && !unsaved) loadTimer = setTimeout(load, RETRY_MS);
        });
    };

    const unsubscribe = useTerminal.subscribe((state, prev) => {
      if (applying || state.watchlist === prev.watchlist) return;
      unsaved = state.watchlist;
      save();
    });

    // Closing the tab cancels timers, so send a pending save right away.
    const flush = () => {
      if (!unsaved) return;
      clearTimeout(saveTimer);
      fetch(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: unsaved }),
        keepalive: true,
      }).catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
      else if (!unsaved) load();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);

    load();

    return () => {
      flush();
      stopped = true;
      clearTimeout(saveTimer);
      clearTimeout(loadTimer);
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
