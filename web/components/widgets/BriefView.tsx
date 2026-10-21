"use client";

import { useState } from "react";
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

  const regenerate = async () => {
    setNote("Requesting…");
    try {
      await apiPost("/api/agents/run/brief", {});
      setNote("Queued: the brief refreshes here when it is written.");
      setTimeout(() => client.invalidateQueries({ queryKey: ["brief"] }), 30_000);
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
