// Live check of the Scan Lab build agent against Claude (not run in CI). Calls the build function in-process
// on a scratch copy of the data and prints each case's per-line outcomes and the definition diff.
//   npx tsx server/scripts/scanlab-eval.mts [caseName...]
// Costs real money (about $0.10 per build). DATA_DIR must be a scratch copy; it is written to.
process.env.DATA_DIR ??= "/private/tmp/claude-501/-Users-vyedlapa-github-openterminal-agent/b606c7ee-29f6-484b-9c60-74a5fe2a0ae6/scratchpad/datacopy";
process.env.AGENTS_DAILY_BUDGET_USD ??= "20";

const sd = await import("../src/scandef/index.js");
const build = await import("../src/scandef/build.js");
const { getDraft, setStatus } = sd;

const OPT = () => sd.render(sd.getActive("option").definition);
const STK = () => sd.render(sd.getActive("stock").definition);

const cases: Record<string, { kind: "option" | "stock"; text: () => string }> = {
  "four option edits": {
    kind: "option",
    text: () =>
      OPT()
        .replace("scores 70 or more", "scores 65 or more")
        .replace("- Near misses: not shown.", "- Near misses: show setups from 55, dimmed.")
        .replace("- Gate · Daily uptrend", "- Gate · Options not expensive: only buy a call when IV rank is 50 or less.\n- Gate · Daily uptrend")
        .replace("- Contract: the at-the-money put (set by the options sweep).", "- Contract: the at-the-money put (set by the options sweep).\n- Skip names whose short interest is above 20% of float."),
  },
  "stock reweight": {
    kind: "stock",
    text: () => STK().replace("- Momentum 20%", "- Momentum 30%").replace("- Valuation 20%", "- Valuation 15%").replace("- Analyst view 10%", "- Analyst view 5%"),
  },
  "forbidden put": {
    kind: "option",
    text: () => OPT().replace("- Near misses: not shown.", "- Near misses: not shown.\n- Buy puts when momentum is negative."),
  },
};

const only = process.argv.slice(2);
for (const [name, c] of Object.entries(cases)) {
  if (only.length && !only.includes(name)) continue;
  const text = c.text();
  console.log(`\n=== ${name} ===`);
  const changed = build.changedLines(sd.render(sd.getActive(c.kind).definition), text);
  console.log("changed lines:\n" + changed.map((l) => `  ${l.n}. [${l.section}] ${l.change}: ${l.text}`).join("\n"));
  const started = build.startBuild(c.kind, undefined, text);
  if (typeof started === "string") {
    console.log("not started:", started);
    continue;
  }
  await build.jobDone(started.jobId);
  const job = build.getJob(started.jobId)!;
  console.log(`status: ${job.status}${job.refused ? " (refused)" : ""}${job.error ? `\nerror: ${job.error}` : ""}`);
  console.log("lines:\n" + job.lines.map((l) => `  ${l.n}. ${l.action}: ${l.explanation}`).join("\n"));
  console.log("notes:\n" + job.notes.map((n) => `  - ${n}`).join("\n"));
  console.log("needsCode:", JSON.stringify(job.needsCode));
  if (job.draftId !== null) {
    const draft = getDraft(c.kind)!;
    const base = sd.getById(draft.parentId!)!;
    console.log("diff:\n" + sd.diff(base.definition, draft.definition).map((d) => `  ${d.label}: ${d.from} -> ${d.to} (${d.change})`).join("\n"));
    setStatus(draft.id, "discarded");
  }
}
process.exit(0);
