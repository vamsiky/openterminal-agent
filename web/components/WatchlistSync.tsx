"use client";

import { useEffect } from "react";
import { apiGet, apiPost } from "../lib/api";
import { useTerminal } from "../store/terminal";

type ServerWatchlist = { name: string; symbols: string[] | null };

const PATH = "/api/watchlists/default";

/**
 * Keeps the watchlist on the server, where agents and the history sync can
 * see it. On load the server copy wins; if the server has none yet, this
 * browser's list seeds it. Every later change is saved back. localStorage
 * stays as a cache, so the terminal still works if the API is down.
 */
export default function WatchlistSync() {
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const save = (symbols: string[]) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        apiPost(PATH, { symbols }).catch(() => {
          // best-effort; the next change retries
        });
      }, 500);
    };

    apiGet<ServerWatchlist>(PATH)
      .then((server) => {
        if (cancelled) return;
        if (server.symbols === null) save(useTerminal.getState().watchlist);
        else useTerminal.getState().setWatchlist(server.symbols);
        unsubscribe = useTerminal.subscribe((state, prev) => {
          if (state.watchlist !== prev.watchlist) save(state.watchlist);
        });
      })
      .catch(() => {
        // API unreachable: keep the local list only
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, []);

  return null;
}
