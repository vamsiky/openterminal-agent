"use client";

import { Async, DataTable, ExtLink, Message, Note, dstr, useResearch, type Column } from "./shared";

type Item = { publishedDate: string; title: string; site: string | null; publisher: string | null; url: string | null };

export function NewsTab({ symbol }: { symbol: string }) {
  const q = useResearch<Item[]>(symbol, "news", "?limit=30");
  const cols: Array<Column<Item>> = [
    { label: "Date", left: true, cls: () => "dim whitespace-nowrap", cell: (n) => dstr(n.publishedDate) },
    { label: "Headline", left: true, cell: (n) => <ExtLink href={n.url}>{n.title}</ExtLink> },
    { label: "Source", left: true, cls: () => "dim", cell: (n) => n.site ?? n.publisher ?? "—" },
  ];
  return (
    <Async q={q} what="news" symbol={symbol} empty={`No recent news for ${symbol}.`}>
      {(rows) => (
        <>
          <Note>Company news from FMP · newest first</Note>
          <DataTable columns={cols} rows={rows} minWidth={420} rowKey={(n, i) => `${n.publishedDate}-${i}`} />
        </>
      )}
    </Async>
  );
}

export function CommentsTab({ symbol }: { symbol: string }) {
  return <Message>Community comments aren’t available: none of the app’s data providers has a community feed. Price alerts for {symbol} will show here once alerts ship in Phase 3.</Message>;
}

export function BondsTab({ symbol }: { symbol: string }) {
  return <Message>No bond data for {symbol}. The app has no corporate-bond source connected yet; Webull shows each bond’s CUSIP, coupon, yield and maturity here.</Message>;
}
