// The latest quote of one option contract, injected by index.ts so agents/ never imports options/ (as quant/ does not).

export type OptionQuoteLike = { bid: number | null; ask: number | null; last: number | null };
let source: ((occ: string) => OptionQuoteLike | null) | null = null;

export const setOptionQuoteSource = (fn: ((occ: string) => OptionQuoteLike | null) | null): void => {
  source = fn;
};

/** Mid of bid and ask (the last trade if there is no two-sided quote); null when the contract is not streamed. */
export function optionMid(occ: string | null): number | null {
  if (!occ || !source) return null;
  const q = source(occ);
  if (!q) return null;
  if (q.bid !== null && q.ask !== null && q.ask > 0) return (q.bid + q.ask) / 2;
  return q.last;
}
