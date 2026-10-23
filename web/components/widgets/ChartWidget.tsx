"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  AreaSeries,
  BarSeries,
  TickMarkType,
  type ISeriesApi,
  type LogicalRange,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { apiGet, fmt, type Candle, type Quote } from "../../lib/api";
import {
  etClock, extremeLabel, extremes, firstDayOf, markerFilter, nearEdge, fmtDay, fmtMove, fmtVolume, rangeSummary, readout,
  sessionVwap, sliceMonths, spansYears, type DailyBar,
} from "../../lib/chartSummary";
import { sma, ema, rsi, macd, bollinger, type Point } from "../../lib/indicators";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import { ExtendedPrices, RegularPrice } from "../SessionPrices";
import Chip from "../ui/Chip";
import DropdownMenu from "../ui/DropdownMenu";
import Segmented from "../ui/Segmented";
import { Freshness } from "./QuoteWidget";

const RANGES = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
const CHART_TYPES = [
  { id: "candles", label: "Candles" },
  { id: "bars", label: "Bars" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
] as const;

type Range = (typeof RANGES)[number];
type ChartType = (typeof CHART_TYPES)[number]["id"];
type IndKey = "SMA20" | "SMA50" | "SMA200" | "EMA20" | "VWAP" | "BOLL" | "VOL" | "RSI" | "MACD";

const UP = "#22d36b";
const DOWN = "#ff5a5a";

const INDICATORS: Array<{ key: IndKey; label: string; color: string; group: "price" | "below"; need: number }> = [
  { key: "SMA20", label: "SMA 20", color: "#ffd966", group: "price", need: 20 },
  { key: "SMA50", label: "SMA 50", color: "#4fc3f7", group: "price", need: 50 },
  { key: "SMA200", label: "SMA 200", color: "#ba68c8", group: "price", need: 200 },
  { key: "EMA20", label: "EMA 20", color: "#ff8a65", group: "price", need: 20 },
  { key: "VWAP", label: "VWAP", color: "#80cbc4", group: "price", need: 1 },
  { key: "BOLL", label: "Bollinger 20 / 2", color: "#ff9900", group: "price", need: 20 },
  { key: "VOL", label: "Volume", color: "#8a8a8a", group: "below", need: 1 },
  { key: "RSI", label: "RSI 14", color: "#ffb84d", group: "below", need: 15 },
  { key: "MACD", label: "MACD 12 / 26 / 9", color: "#6b8cff", group: "below", need: 35 },
];

const INTRADAY_CHART = new Set<Range>(["1D", "5D", "1M"]);
const VWAP_RANGES = new Set<Range>(["1D", "5D"]);

const ts = (t: number) => t as UTCTimestamp;
const toMap = (pts: Point[]) => new Map(pts.map((p) => [p.time, p.value]));
const asNum = (t: Time) => t as number;

type Series = Record<string, Map<number, number>>;

export default function ChartWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const [range, setRange] = useState<Range>("6M");
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [active, setActive] = useState<Set<IndKey>>(new Set(["SMA20", "VOL"]));
  const [hover, setHover] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const savedView = useRef<{ key: string; range: LogicalRange } | null>(null);

  const intraday = INTRADAY_CHART.has(range);
  // The server has no 3M range; it serves 6M and the client keeps the last three months.
  const fetchRange = range === "3M" ? "6M" : range;

  const { data: history, error } = useQuery({
    queryKey: ["history", symbol, fetchRange],
    queryFn: () => apiGet<Candle[]>(`/api/history/${encodeURIComponent(symbol)}?range=${fetchRange}`),
    refetchInterval: range === "1D" ? 8_000 : 60_000,
  });
  const candles = useMemo(() => (history && range === "3M" ? sliceMonths(history, 3) : history), [history, range]);

  // Official daily bars over the range's dates give the real open/close/high/low (intraday candles include extended hours).
  const firstDay = candles ? firstDayOf(candles, range) : null;
  const { data: daily } = useQuery({
    queryKey: ["bars-daily", symbol, firstDay],
    queryFn: () => apiGet<DailyBar[]>(`/api/bars/daily/${encodeURIComponent(symbol)}?from=${firstDay}`),
    enabled: firstDay !== null,
    staleTime: 300_000,
    retry: false,
  });

  // Same query as the quote widget, so the two share one request.
  const { data: quote } = useQuery({
    queryKey: ["quote", symbol],
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${encodeURIComponent(symbol)}`))[0],
    refetchInterval: 1_000,
  });

  const indexByTime = useMemo(() => new Map((candles ?? []).map((c, i) => [c.time, i])), [candles]);
  const withYear = useMemo(() => (candles ? spansYears(candles, intraday) : false), [candles, intraday]);

  // Every indicator is computed so the menu can show its current value; `active` only decides what is drawn.
  const ind = useMemo(() => {
    if (!candles || candles.length === 0) return null;
    const boll = bollinger(candles);
    const m = macd(candles);
    const pts = {
      SMA20: sma(candles, 20), SMA50: sma(candles, 50), SMA200: sma(candles, 200), EMA20: ema(candles, 20),
      VWAP: VWAP_RANGES.has(range) ? sessionVwap(candles) : [], RSI: rsi(candles),
    };
    const maps: Series = {};
    for (const [k, v] of Object.entries(pts)) maps[k] = toMap(v);
    maps.BOLL_U = toMap(boll.upper);
    maps.BOLL_M = toMap(boll.middle);
    maps.BOLL_L = toMap(boll.lower);
    maps.MACD_M = toMap(m.macd);
    maps.MACD_S = toMap(m.signal);
    maps.MACD_H = toMap(m.histogram);
    return { pts, boll, macd: m, maps };
  }, [candles, range]);

  const unavailable = (key: IndKey): string | null => {
    if (!candles) return null;
    if (key === "VWAP" && !VWAP_RANGES.has(range)) return "Intraday ranges only (1D, 5D)";
    const need = INDICATORS.find((i) => i.key === key)!.need;
    if (need > 1 && candles.length < need) return `Needs ${need} bars, this range has ${candles.length}`;
    return null;
  };

  // The indicator's value at the hovered bar, or at the latest bar.
  const valueText = (key: IndKey): string => {
    if (!ind || !candles || candles.length === 0 || unavailable(key)) return "";
    const t = candles[hover ?? candles.length - 1].time;
    const get = (k: string) => ind.maps[k]?.get(t);
    const one = (v: number | undefined, d = 2) => (v === undefined ? "—" : fmt(v, d));
    switch (key) {
      case "BOLL": return get("BOLL_M") === undefined ? "—" : `${one(get("BOLL_U"))} / ${one(get("BOLL_M"))} / ${one(get("BOLL_L"))}`;
      case "MACD": return get("MACD_M") === undefined ? "—" : `${one(get("MACD_M"))} / ${one(get("MACD_S"))} / ${one(get("MACD_H"))}`;
      case "RSI": return one(get("RSI"), 1);
      case "VOL": return fmtVolume(candles[hover ?? candles.length - 1].volume);
      default: return one(get(key));
    }
  };

  useEffect(() => setHover(null), [candles]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !candles || candles.length === 0 || !ind) return;
    const on = (k: IndKey) => active.has(k) && !unavailable(k);

    const chart = createChart(el, {
      layout: { background: { color: "#0a0a0a" }, textColor: "#808080", fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: "#1a1a1a" }, horzLines: { color: "#1a1a1a" } },
      crosshair: { mode: 0, vertLine: { style: 3, color: "#555", labelBackgroundColor: "#ff9900" }, horzLine: { style: 3, color: "#555", labelBackgroundColor: "#ff9900" } },
      timeScale: {
        borderColor: "#262626",
        timeVisible: intraday,
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          const t = asNum(time);
          if (type === TickMarkType.Year) return String(new Date(t * 1000).getUTCFullYear());
          if (type === TickMarkType.Month) return fmtDay(t, intraday, false).split(" ")[0];
          if (type === TickMarkType.DayOfMonth) return fmtDay(t, intraday, false);
          return etClock(t);
        },
      },
      localization: {
        timeFormatter: (time: Time) => {
          const t = asNum(time);
          return intraday ? `${fmtDay(t, true, withYear)} ${etClock(t)} ET` : fmtDay(t, false, true);
        },
      },
      rightPriceScale: { borderColor: "#262626" },
      autoSize: true,
      // Mouse-wheel is left free for page scrolling: zoom via drag, pinch, or the range buttons instead.
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
    });

    const ohlc = candles.map((c) => ({ time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close }));
    const closes = candles.map((c) => ({ time: ts(c.time), value: c.close }));
    let main: ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line"> | ISeriesApi<"Area">;
    if (chartType === "candles") {
      main = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
      });
      main.setData(ohlc);
    } else if (chartType === "bars") {
      main = chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN });
      main.setData(ohlc);
    } else if (chartType === "line") {
      main = chart.addSeries(LineSeries, { color: "#ff9900", lineWidth: 2 });
      main.setData(closes);
    } else {
      main = chart.addSeries(AreaSeries, { lineColor: "#ff9900", topColor: "rgba(255,153,0,0.25)", bottomColor: "rgba(255,153,0,0)" });
      main.setData(closes);
    }

    if (on("VOL")) {
      const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
      vol.setData(candles.map((c) => ({ time: ts(c.time), value: c.volume, color: c.close >= c.open ? "rgba(34,211,107,0.35)" : "rgba(255,90,90,0.35)" })));
    }

    const color = (k: IndKey) => INDICATORS.find((i) => i.key === k)!.color;
    const overlay = (points: Point[], c: string) =>
      chart.addSeries(LineSeries, { color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
        .setData(points.map((p) => ({ time: ts(p.time), value: p.value })));
    for (const k of ["SMA20", "SMA50", "SMA200", "EMA20", "VWAP"] as const) if (on(k)) overlay(ind.pts[k], color(k));
    if (on("BOLL")) {
      overlay(ind.boll.upper, "rgba(255,153,0,0.5)");
      overlay(ind.boll.middle, "rgba(255,153,0,0.8)");
      overlay(ind.boll.lower, "rgba(255,153,0,0.5)");
    }

    let pane = 1;
    if (on("RSI")) {
      chart.addSeries(LineSeries, { color: color("RSI"), lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, pane++)
        .setData(ind.pts.RSI.map((p) => ({ time: ts(p.time), value: p.value })));
    }
    if (on("MACD")) {
      const m = ind.macd;
      const p = pane++;
      chart.addSeries(HistogramSeries, { color: "#6b8cff", lastValueVisible: false, priceLineVisible: false }, p).setData(
        m.histogram.map((x) => ({ time: ts(x.time), value: x.value, color: x.value >= 0 ? "rgba(34,211,107,0.6)" : "rgba(255,90,90,0.6)" }))
      );
      chart.addSeries(LineSeries, { color: "#ff9900", lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, p)
        .setData(m.macd.map((x) => ({ time: ts(x.time), value: x.value })));
      chart.addSeries(LineSeries, { color: "#ffffff", lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, p)
        .setData(m.signal.map((x) => ({ time: ts(x.time), value: x.value })));
    }
    if (pane > 1) {
      const panes = chart.panes();
      panes[0]?.setStretchFactor(3);
      for (let i = 1; i < pane; i++) panes[i]?.setStretchFactor(1);
    }

    // High and low of the bars in view, drawn as series markers so nothing sits over the plot.
    const markers = createSeriesMarkers(main, []);
    const refreshMarkers = (r: LogicalRange | null) => {
      const include = markerFilter(range);
      const from = r ? r.from : 0;
      const to = r ? r.to : candles.length - 1;
      const e = extremes(candles, from, to, include);
      if (!e) return markers.setMarkers([]);
      // Near an edge the label would be clipped, so it drops the date and time.
      const label = (kind: "H" | "L", x: typeof e.high) => extremeLabel(kind, x, intraday, withYear, nearEdge(x.index, from, to));
      const list: SeriesMarker<Time>[] = [
        { time: ts(e.high.time), position: "aboveBar", shape: "circle", color: "#ededed", text: label("H", e.high) },
        { time: ts(e.low.time), position: "belowBar", shape: "circle", color: "#ededed", text: label("L", e.low) },
      ];
      markers.setMarkers(list.sort((a, b) => asNum(a.time) - asNum(b.time)));
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshMarkers);

    chart.subscribeCrosshairMove((param) => {
      setHover(param.time === undefined ? null : indexByTime.get(asNum(param.time)) ?? null);
    });

    // A refetch rebuilds the chart; keep the pan and zoom unless the symbol, range or type changed.
    const viewKey = `${symbol}|${range}|${chartType}`;
    const saved = savedView.current;
    if (saved && saved.key === viewKey) chart.timeScale().setVisibleLogicalRange(saved.range);
    else chart.timeScale().fitContent();
    refreshMarkers(chart.timeScale().getVisibleLogicalRange());

    return () => {
      const r = chart.timeScale().getVisibleLogicalRange();
      if (r) savedView.current = { key: viewKey, range: r };
      chart.remove();
    };
    // `unavailable` is derived from range and candles, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, chartType, ind, range, active, intraday, withYear, indexByTime, symbol]);

  const toggle = (k: IndKey) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const summary = useMemo(() => (candles ? rangeSummary(candles, range, daily) : null), [candles, range, daily]);
  const hov = candles && hover !== null ? readout(candles, hover, intraday) : null;
  const activeInds = INDICATORS.filter((i) => active.has(i.key));
  const row = (key: IndKey) => {
    const i = INDICATORS.find((x) => x.key === key)!;
    const note = unavailable(key);
    return (
      <label key={key} className={`flex items-center gap-2 px-2 py-1 rounded ${note ? "opacity-60" : "hover:bg-[#1c1c1f] cursor-pointer"}`}>
        <input type="checkbox" checked={active.has(key)} disabled={note !== null && !active.has(key)} onChange={() => toggle(key)} />
        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: i.color }} />
        <span className="flex-1 whitespace-nowrap">{i.label}</span>
        <span className="dim text-[11px] whitespace-nowrap">{note ?? valueText(key)}</span>
      </label>
    );
  };
  const section = (title: string, group: "price" | "below") => (
    <>
      <div className="dim text-[11px] px-2 pt-2 pb-0.5">{title}</div>
      {INDICATORS.filter((i) => i.group === group).map((i) => row(i.key))}
    </>
  );

  const cc = (n: number) => (n >= 0 ? "up" : "down");

  return (
    <div className="flex flex-col h-full min-h-[240px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 pt-2 pb-1.5 shrink-0">
        {quote && (
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="amber font-bold">{symbol}</span>
            <RegularPrice quote={quote} size="text-base" />
            <span className="dim text-[10px]"><Freshness quote={quote} /></span>
            <ExtendedPrices quote={quote} />
          </span>
        )}
        <span className="flex-1" />
        <Segmented ariaLabel="Chart range" options={RANGES.map((r) => ({ id: r, label: r }))} value={range} onChange={(r) => setRange(r as Range)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-2.5 pb-1.5 shrink-0">
        <Segmented ariaLabel="Chart type" options={[...CHART_TYPES]} value={chartType} onChange={(t) => setChartType(t as ChartType)} />
        <DropdownMenu
          ariaLabel="Indicators"
          trigger={<span>Indicators · {activeInds.length}</span>}
          panelClassName="!w-[300px] !p-1.5"
        >
          {(close) => (
            <div className="text-xs">
              {section("On the price chart", "price")}
              <div className="border-t border-[#2a2a2d] mt-1" />
              {section("Below the chart", "below")}
              <div className="flex justify-between border-t border-[#2a2a2d] mt-1.5 pt-2 px-1">
                <Chip onClick={() => setActive(new Set())}>Turn all off</Chip>
                <Chip on onClick={close}>Done</Chip>
              </div>
            </div>
          )}
        </DropdownMenu>
        {activeInds.map((i) => {
          const note = unavailable(i.key);
          return (
            <Chip key={i.key} onRemove={() => toggle(i.key)} title={note ?? undefined}>
              <span className="w-2 h-2 rounded-sm" style={{ background: i.color }} />
              {i.label}
              <span className="dim text-[11px]">{note ? "n/a" : valueText(i.key)}</span>
            </Chip>
          );
        })}
      </div>
      {error && <div className="px-2.5 down text-xs">Error: {(error as Error).message}</div>}
      {/* Summary and crosshair readout share one grid cell so the height never changes. */}
      <div className="shrink-0 grid px-4 pb-1 text-[11px] min-h-[34px] content-start">
        <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5 [grid-area:1/1]" style={{ visibility: hov ? "hidden" : "visible" }}>
          {summary && (
            <>
              <span className="whitespace-nowrap">
                <span className="dim">{summary.label}</span>{" "}
                <span className={`${cc(summary.change)} font-bold text-[13px]`}>
                  {summary.pct === null ? "—" : `${summary.pct > 0 ? "+" : summary.pct < 0 ? "−" : ""}${fmt(Math.abs(summary.pct))}%`}
                </span>{" "}
                <span className={cc(summary.change)}>{summary.change > 0 ? "+" : summary.change < 0 ? "−" : ""}{fmt(Math.abs(summary.change))}</span>
              </span>
              <span className="whitespace-nowrap"><span className="dim">Open</span> {fmt(summary.open)} <span className="dim">{summary.openWhen}</span></span>
              <span className="whitespace-nowrap"><span className="dim">Close</span> {fmt(summary.close)} <span className="dim">{summary.closeWhen}</span></span>
              <span className="whitespace-nowrap"><span className="dim">High</span> {fmt(summary.high)}</span>
              <span className="whitespace-nowrap"><span className="dim">Low</span> {fmt(summary.low)}</span>
            </>
          )}
        </div>
        <div aria-live="polite" className="flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5 [grid-area:1/1]" style={{ visibility: hov ? "visible" : "hidden" }}>
          {hov && (
            <>
              <span className="font-semibold text-[#ededed] whitespace-nowrap">{hov.when}</span>
              <span className="whitespace-nowrap"><span className="dim">O</span> {fmt(hov.open)}</span>
              <span className="whitespace-nowrap"><span className="dim">H</span> {fmt(hov.high)}</span>
              <span className="whitespace-nowrap"><span className="dim">L</span> {fmt(hov.low)}</span>
              <span className="whitespace-nowrap"><span className="dim">C</span> <span className="text-[#ededed]">{fmt(hov.close)}</span></span>
              <span className={`${cc(hov.change)} whitespace-nowrap`}>{fmtMove(hov.change, hov.pct)}</span>
              <span className="whitespace-nowrap"><span className="dim">Vol</span> {fmtVolume(hov.volume)}</span>
            </>
          )}
        </div>
      </div>
      <div className="relative flex-1 min-h-[120px]">
        <div ref={containerRef} className="absolute inset-0" onPointerLeave={() => setHover(null)} />
        {candles && candles.length === 0 && <div className="absolute inset-0 flex items-center justify-center dim">No bars for {symbol} in this range.</div>}
        {!candles && !error && <div className="absolute inset-0 flex items-center justify-center dim">Loading {symbol}…</div>}
      </div>
    </div>
  );
}
