"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../../lib/api";
import { defaultExpiry, todayET, type Chain } from "../../lib/chain";

export const CHAIN_REFRESH_MS = 15_000;

const fetchChain = (symbol: string, expiry?: string) =>
  apiGet<Chain>(`/api/options/${encodeURIComponent(symbol)}${expiry ? `?expiry=${encodeURIComponent(expiry)}` : ""}`);

/**
 * One chain, refetched every 15 s while mounted. Without `expiry` the nearest one after today is loaded
 * (the API's own default can be today's, which has no IV or greeks), costing one extra call.
 */
export function useChain(symbol: string, expiry?: string) {
  return useQuery({
    queryKey: ["options", symbol, expiry ?? "auto"],
    queryFn: async () => {
      let chain = await fetchChain(symbol, expiry);
      if (!expiry) {
        const want = defaultExpiry(chain.expirationDates, todayET());
        if (want && want !== chain.selectedDate) chain = await fetchChain(symbol, want);
      }
      return chain;
    },
    refetchInterval: CHAIN_REFRESH_MS,
    retry: 0,
  });
}
