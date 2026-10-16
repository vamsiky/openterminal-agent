import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Secrets such as the Alpaca market-data keys live in a gitignored .env file
// at the repo root (see .env.example), so they never have to be exported in a
// shell profile or typed into a chat. Variables already set in the real
// environment win: process.loadEnvFile never overwrites them. ENV_FILE points
// elsewhere, e.g. a file outside the checkout on a server.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envFile = process.env.ENV_FILE ?? join(root, ".env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
