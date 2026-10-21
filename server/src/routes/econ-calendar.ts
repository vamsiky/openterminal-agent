import type { EconEvent } from "../providers/types.js";
import type { EconEvent as FmpEconEvent } from "../providers/fmp.js";

// The official schedules (calendars.ts) say when a release comes out but carry
// no numbers. FMP's economic calendar has forecast/previous/actual, split into
// many rows per release (CPI MoM, CPI YoY, core CPI...). Each official release
// takes the values of its headline row, matched by name and time.
//
// FMP event names are UNCONFIRMED (no key while this was written): check them
// against a real /economic-calendar response.

const HEADLINE: Array<[official: RegExp, fmp: RegExp]> = [
  [/^Employment Situation/i, /non ?farm payrolls/i],
  [/^Consumer Price Index/i, /^(inflation rate|cpi) yoy/i],
  [/^Producer Price Index/i, /^ppi (mom|yoy)/i],
  [/^Gross Domestic Product/i, /^gdp growth rate/i],
  [/^Personal Income and Outlays/i, /^core pce price index (mom|yoy)/i],
  [/^Job Openings/i, /jolts job openings/i],
  [/^FOMC Statement/i, /interest rate decision/i],
  [/Retail Sales/i, /^retail sales mom/i],
  [/^Employment Cost Index/i, /^employment cost index/i],
  [/^U\.S\. International Trade/i, /^balance of trade/i],
  [/^EIA Weekly Petroleum/i, /eia crude oil (stocks|inventories)/i],
];

// FMP's times are assumed UTC (UNCONFIRMED); allow for a clock or timezone slip.
const WINDOW_MS = 90 * 60_000;

/** Official events, each with the forecast/previous/actual of its FMP headline row where one matches. */
export function withConsensus(official: EconEvent[], consensus: FmpEconEvent[]): EconEvent[] {
  const us = consensus.filter((c) => c.country === "US");
  return official.map((e) => {
    const pattern = HEADLINE.find(([re]) => re.test(e.title))?.[1];
    if (!pattern) return e;
    const at = Date.parse(e.date);
    const hit = us.find((c) => pattern.test(c.title) && Math.abs(Date.parse(c.date) - at) <= WINDOW_MS);
    if (!hit) return e;
    return { ...e, title: `${e.title}: ${hit.title}`, forecast: hit.forecast, previous: hit.previous, actual: hit.actual };
  });
}
