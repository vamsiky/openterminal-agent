import { nyClock } from "../history/scheduler.js";
import { candidatesFor } from "../quant/ideas.js";
import type { OptionScanResult } from "../quant/option-score.js";
import type { IntradayResult } from "../quant/stock-score.js";
import { getById, getActive } from "../scandef/store.js";
import type { OptionDefinition, StockDefinition } from "../scandef/schema.js";
import { optionResult, stockResult } from "./result.js";
import { shadowOption, stockResultOf, type OptionSnapshot, type StockSnapshot } from "./replay.js";
import { addShadowPass, pruneInputs, saveInput, shadowing, type ShadowPass } from "./store.js";

// Called by the scheduled passes (quant/jobs.ts) after they have scored and listed with the active definition.
// Stores what the pass scored and, while a shadow is on, scores the draft on the same inputs. Never writes ideas,
// near misses or agent triggers, and never throws into the pass.

function shadowDraft<D extends OptionDefinition | StockDefinition>(kind: D["kind"]): { id: number; def: D } | null {
  const s = shadowing(kind);
  if (!s) return null;
  const rec = getById(s.defId);
  return rec && rec.status === "draft" ? { id: rec.id, def: rec.definition as D } : null;
}

export function captureOptionPass(r: OptionScanResult): void {
  try {
    const def = getActive("option");
    const live = optionResult(def.definition, r.symbols.map((s) => ({ symbol: s.symbol, metrics: s.inputs.metrics, evaluation: s.evaluation })), r.asOf);
    const snap: OptionSnapshot = { v: 1, asOf: r.asOf, def: def.definition, symbols: r.symbols.map((s) => ({ symbol: s.symbol, inputs: s.inputs })), live };
    saveInput("option", r.asOf, nyClock(new Date(r.asOf)).date, r.definition, snap);
    const draft = shadowDraft<OptionDefinition>("option");
    if (draft) addShadowPass(draft.id, "option", { at: r.asOf, live, draft: shadowOption(snap, draft.def) } satisfies ShadowPass);
  } catch (err) {
    console.error("[scan] option pass snapshot failed:", err);
  }
}

export function captureStockPass(r: IntradayResult, now: Date): void {
  try {
    if (r.cards.length === 0) return;
    const asOf = now.toISOString();
    const today = nyClock(now).date;
    const cands = candidatesFor(r.cards, today);
    const def = r.definition;
    const byKey = new Map(cands.map((c) => [c.card.symbol, c]));
    const snap: StockSnapshot = {
      v: 1,
      asOf,
      day: r.nightlyDay,
      def,
      symbols: r.cards.map((c) => ({
        symbol: c.symbol,
        sector: c.sector,
        industry: c.industry,
        price: byKey.get(c.symbol)?.price ?? null,
        nextEarningsDays: byKey.get(c.symbol)?.nextEarningsDays ?? null,
        factors: c.factors.map((f) => [f.key, f.group, f.value, f.score]),
      })),
      live: stockResult(def, cands, asOf),
    };
    saveInput("stock", asOf, today, def.version, snap);
    const draft = shadowDraft<StockDefinition>("stock");
    if (draft) addShadowPass(draft.id, "stock", { at: asOf, live: snap.live, draft: stockResultOf(snap, draft.def) });
  } catch (err) {
    console.error("[scan] stock pass snapshot failed:", err);
  }
}

/** Nightly: keep the last 10 trading days of inputs. */
export function pruneTestData(now: Date): void {
  try {
    pruneInputs(nyClock(now).date);
  } catch (err) {
    console.error("[scan] pruning scan inputs failed:", err);
  }
}

