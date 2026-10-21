"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "../../lib/api";
import { isSafeHttpUrl } from "../../lib/links";
import ErrorNote from "../ErrorNote";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";

type NewsItem = { title: string; link: string; publisher: string | null; publishedAt: string | null };
type PressRelease = { title: string; url: string | null; publisher: string | null; publishedDate: string };
type Mode = "symbol" | "global" | "press";

async function fetchPress(symbol: string): Promise<NewsItem[]> {
  const res = await apiGet<{ data: PressRelease[] }>(`/api/research/${encodeURIComponent(symbol)}/press-releases?limit=30`);
  // publishedDate is New York wall time with no zone, so it is shown as written rather than parsed.
  return res.data.map((p) => ({ title: p.title, link: p.url ?? "", publisher: p.publisher, publishedAt: p.publishedDate.slice(0, 16) }));
}

export default function NewsWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const [mode, setMode] = useState<Mode>("symbol");

  const { data = [], isLoading, error } = useQuery({
    queryKey: ["news", mode, symbol],
    queryFn: () =>
      mode === "press"
        ? fetchPress(symbol)
        : apiGet<NewsItem[]>(mode === "symbol" ? `/api/news?symbol=${encodeURIComponent(symbol)}` : "/api/news"),
    refetchInterval: 30_000,
    retry: 0,
  });

  return (
    <div>
      <div className="flex gap-1 p-1">
        <button className={`term-btn ${mode === "symbol" ? "active" : ""}`} onClick={() => setMode("symbol")}>
          {symbol}
        </button>
        <button className={`term-btn ${mode === "global" ? "active" : ""}`} onClick={() => setMode("global")}>
          GLOBAL
        </button>
        <button className={`term-btn ${mode === "press" ? "active" : ""}`} onClick={() => setMode("press")}>
          PRESS
        </button>
      </div>
      {error ? <ErrorNote error={error} /> : isLoading && <div className="p-2 dim">Loading news…</div>}
      {data.map((n, i) => {
        const body = (
          <>
            <div className="truncate">{n.title}</div>
            <div className="dim text-[10px]">
              {n.publisher ?? ""}
              {n.publishedAt ? (n.publisher ? " · " : "") + (mode === "press" ? n.publishedAt : new Date(n.publishedAt).toLocaleString()) : ""}
            </div>
          </>
        );
        const className = "block px-2 py-1 border-b border-[#161616] hover:bg-[#161616]";
        return isSafeHttpUrl(n.link) ? (
          <a key={i} href={n.link} target="_blank" rel="noreferrer" className={className}>
            {body}
          </a>
        ) : (
          <div key={i} className={className}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
