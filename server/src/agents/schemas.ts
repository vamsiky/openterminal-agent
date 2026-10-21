import { z } from "zod";

// Structured outputs of the agents: a zod validator (the check that counts)
// and the JSON schema the model is asked to follow.

const evidence = z.object({ claim: z.string().min(1), source: z.string().min(1), asOf: z.string().nullable() });
const evidenceJson = {
  type: "object",
  properties: { claim: { type: "string" }, source: { type: "string", description: "tool and section, e.g. fundamentals:estimates" }, asOf: { type: ["string", "null"], description: "as-of date of the data, or null" } },
  required: ["claim", "source", "asOf"],
  additionalProperties: false,
};
const evidenceList = { type: "array", items: evidenceJson };
const nullableNumber = { type: ["number", "null"] };
const str = { type: "string" };

export const macroOutput = z.object({
  regime: z.object({
    rates: z.enum(["rising", "falling", "flat", "unknown"]),
    risk: z.enum(["on", "off", "neutral", "unknown"]),
    volatility: z.enum(["low", "normal", "elevated", "high", "unknown"]),
    dollar: z.enum(["strong", "weak", "flat", "unknown"]),
    oil: z.enum(["rising", "falling", "flat", "unknown"]),
  }),
  summary: z.string().min(1),
  events: z.array(z.object({ time: z.string().nullable(), event: z.string(), importance: z.enum(["high", "medium", "low"]) })),
  risks: z.array(z.string()),
  evidence: z.array(evidence),
});
export type MacroOutput = z.infer<typeof macroOutput>;
export const macroJson = {
  type: "object",
  properties: {
    regime: {
      type: "object",
      properties: {
        rates: { enum: ["rising", "falling", "flat", "unknown"] },
        risk: { enum: ["on", "off", "neutral", "unknown"] },
        volatility: { enum: ["low", "normal", "elevated", "high", "unknown"] },
        dollar: { enum: ["strong", "weak", "flat", "unknown"] },
        oil: { enum: ["rising", "falling", "flat", "unknown"] },
      },
      required: ["rates", "risk", "volatility", "dollar", "oil"],
      additionalProperties: false,
    },
    summary: str,
    events: { type: "array", items: { type: "object", properties: { time: { type: ["string", "null"] }, event: str, importance: { enum: ["high", "medium", "low"] } }, required: ["time", "event", "importance"], additionalProperties: false } },
    risks: { type: "array", items: str },
    evidence: evidenceList,
  },
  required: ["regime", "summary", "events", "risks", "evidence"],
  additionalProperties: false,
};

export const caseOutput = z.object({
  summary: z.string().min(1),
  points: z.array(z.object({ point: z.string().min(1), evidence: z.array(evidence) })).min(1),
});
export type CaseOutput = z.infer<typeof caseOutput>;
export const caseJson = {
  type: "object",
  properties: {
    summary: str,
    points: { type: "array", items: { type: "object", properties: { point: str, evidence: evidenceList }, required: ["point", "evidence"], additionalProperties: false } },
  },
  required: ["summary", "points"],
  additionalProperties: false,
};

const num = z.number().nullable();
export const judgeOutput = z.object({
  verdict: z.enum(["act", "wait", "pass"]),
  confidence: z.number().min(0).max(100),
  horizon: z.string().min(1),
  entry: z.object({ low: num, high: num, note: z.string() }),
  target: z.object({ price: num, note: z.string() }),
  invalidation: z.object({ price: num, condition: z.string() }),
  exitPlan: z.string().min(1),
  catalysts: z.array(z.object({ date: z.string().nullable(), event: z.string() })),
  risks: z.array(z.string()),
  summary: z.string().min(1),
  evidence: z.array(evidence),
});
export type JudgeOutput = z.infer<typeof judgeOutput>;
export const judgeJson = {
  type: "object",
  properties: {
    verdict: { enum: ["act", "wait", "pass"] },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    horizon: str,
    entry: { type: "object", description: "Stock theses: underlying price zone. Option theses: the option PREMIUM per share to pay or receive.", properties: { low: nullableNumber, high: nullableNumber, note: str }, required: ["low", "high", "note"], additionalProperties: false },
    target: { type: "object", description: "Stock theses: underlying price. Option theses: the option PREMIUM per share at which to take profit.", properties: { price: nullableNumber, note: str }, required: ["price", "note"], additionalProperties: false },
    invalidation: { type: "object", description: "Always an UNDERLYING stock price (or a condition), never an option premium.", properties: { price: nullableNumber, condition: str }, required: ["price", "condition"], additionalProperties: false },
    exitPlan: str,
    catalysts: { type: "array", items: { type: "object", properties: { date: { type: ["string", "null"], description: "YYYY-MM-DD" }, event: str }, required: ["date", "event"], additionalProperties: false } },
    risks: { type: "array", items: str },
    summary: str,
    evidence: evidenceList,
  },
  required: ["verdict", "confidence", "horizon", "entry", "target", "invalidation", "exitPlan", "catalysts", "risks", "summary", "evidence"],
  additionalProperties: false,
};

export const briefOutput = z.object({ markdown: z.string().min(20) });
export type BriefOutput = z.infer<typeof briefOutput>;
export const briefJson = { type: "object", properties: { markdown: str }, required: ["markdown"], additionalProperties: false };
