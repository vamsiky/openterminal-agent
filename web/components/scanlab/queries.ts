import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../../lib/api";
import type { BuildJob, CatalogField, Compare, DefsResponse, DefView, ScanKind } from "../../lib/scanlab";

export const defsKey = (kind: ScanKind) => ["scanlab", "defs", kind] as const;
export const defKey = (id: number | null | undefined) => ["scanlab", "def", id] as const;

export const useDefs = (kind: ScanKind) =>
  useQuery({ queryKey: defsKey(kind), queryFn: () => apiGet<DefsResponse>(`/api/scan/defs?kind=${kind}`), refetchInterval: 60_000 });

/** A definition's view; polled while a live shadow run is on, so new passes show up. */
export const useDefView = (id: number | null | undefined) =>
  useQuery({
    queryKey: defKey(id),
    queryFn: () => apiGet<DefView>(`/api/scan/defs/${id}`),
    enabled: id != null,
    refetchInterval: (q) => (q.state.data?.tests?.shadow?.on ? 15_000 : false),
  });

export const useCatalog = (kind: ScanKind) =>
  useQuery({
    queryKey: ["scanlab", "catalog", kind],
    queryFn: async () => (await apiGet<{ fields: CatalogField[] }>(`/api/scan/catalog?scope=${kind}`)).fields,
    staleTime: 300_000,
  });

export const useCompare = (id: number | null | undefined, source: "replay" | "shadow", enabled: boolean) =>
  useQuery({
    queryKey: ["scanlab", "compare", id, source],
    queryFn: () => apiGet<Compare>(`/api/scan/defs/${id}/compare?source=${source}`),
    enabled: enabled && id != null,
    refetchInterval: source === "shadow" ? 15_000 : false,
  });

export const useBuildJob = (jobId: string | null) =>
  useQuery({
    queryKey: ["scanlab", "build", jobId],
    queryFn: () => apiGet<BuildJob>(`/api/scan/defs/build/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== "running" ? false : 1500),
    retry: false,
  });
