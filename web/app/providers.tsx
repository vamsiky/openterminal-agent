"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { syncStoreAcrossWindows } from "../store/terminal";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            // A 503 means a key is missing; asking again won't change that.
            retry: (failures, error) => !(error instanceof ApiError && error.status === 503) && failures < 1,
            staleTime: 10_000,
          },
        },
      })
  );
  useEffect(() => syncStoreAcrossWindows(), []);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
