import "../env.js";
import { readFileSync } from "node:fs";
import { importWebull, listWatchlists } from "../routes/watchlists.js";

// Usage (from the repo root):
//   npm run watchlists -w server -- import ~/Downloads/webull_watchlists.csv
//   npm run watchlists -w server -- list
// Importing replaces lists with the same name and leaves the others alone.
// An open browser tab picks the lists up when it next comes into view.

const [command = "list", file] = process.argv.slice(2);
if (command === "import") {
  if (!file) {
    console.error("usage: import <webull export .csv>");
    process.exit(2);
  }
  const { saved, skipped } = importWebull(readFileSync(file, "utf8"));
  for (const l of saved) console.log(`${l.name.padEnd(24)} ${l.symbols} symbols`);
  if (skipped.length) console.log(`Skipped (name or symbols not accepted): ${skipped.join(", ")}`);
  console.log(`Imported ${saved.length} watchlists.`);
} else if (command === "list") {
  for (const l of listWatchlists()) console.log(`${l.name.padEnd(24)} ${l.symbols.length}  ${l.symbols.slice(0, 8).join(" ")}${l.symbols.length > 8 ? " …" : ""}`);
} else {
  console.error(`unknown command "${command}" (use import or list)`);
  process.exit(2);
}
