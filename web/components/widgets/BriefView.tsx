"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiGet, apiPost } from "../../lib/api";
import type { Brief } from "../../lib/agents";
import { ago } from "../../lib/ideas";
import ErrorNote from "../ErrorNote";
import Markdown from "../Markdown";

export default function BriefView() {
  const client = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const brief = useQuery({
    queryKey: ["brief"],
    queryFn: async () => {
      try {
        return await apiGet<Brief>("/api/agents/brief/latest");
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    refetchInterval: 300_000,
  });

  // After Regenerate: poll every 10 s for up to 3 min until a brief newer than the one shown arrives.
  const [waitingSince, setWaitingSince] = useState<string | null>(null);
  const shownAsOf = useRef<string | null>(null);
  shownAsOf.current = brief.data?.asOf ?? null;
  useEffect(() => {
    if (waitingSince === null) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if ((shownAsOf.current ?? "") > waitingSince || Date.now() - started > 180_000) {
        clearInterval(timer);
        setWaitingSince(null);
        return;
      }
      client.invalidateQueries({ queryKey: ["brief"] });
    }, 10_000);
    return () => clearInterval(timer);
  }, [waitingSince, client]);

  const regenerate = async () => {
    setNote("Requesting…");
    try {
      await apiPost("/api/agents/run/brief", {});
      setNote("Queued: the brief refreshes here when it is written.");
      setWaitingSince(shownAsOf.current ?? "");
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setNote(status === 409 ? "Already running." : status === 402 ? "Daily AI budget reached." : status === 503 ? "AI agents are disabled." : `Failed: ${(err as Error).message}`);
    }
  };

  return (
    <div className="p-2">
      <div className="flex items-center gap-2 mb-2">
        <span className="dim flex-1">{brief.data ? `Brief for ${brief.data.day} · written ${ago(brief.data.asOf)}` : "Pre-market brief"}</span>
        {note && <span className="dim">{note}</span>}
        <button className="term-btn" onClick={regenerate}>Regenerate</button>
      </div>
      {brief.isLoading ? (
        <div className="dim">Loading brief…</div>
      ) : brief.error ? (
        <ErrorNote error={brief.error} />
      ) : brief.data ? (
        <Markdown text={brief.data.markdown} />
      ) : (
        <div className="dim">No brief yet: it is written at 07:00 ET on trading days.</div>
      )}
    </div>
  );
}
