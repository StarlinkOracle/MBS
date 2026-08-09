import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const requiredFiles = [
  "package.json",
  "index.html",
  "vite.config.js",
  "src/main.jsx",
  "src/App.jsx",
  "src/lib/apiClient.js",
  "src/context/AuthContext.jsx",
  "src/hooks/useQuery.js",
];

const missing = requiredFiles.filter((file) => !existsSync(resolve(process.cwd(), file)));

if (missing.length > 0) {
  console.error("Smoke check failed. Missing files:");
  missing.forEach((file) => console.error(`- ${file}`));
  process.exit(1);
}

const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
const api = readFileSync(resolve(process.cwd(), "src/lib/apiClient.js"), "utf8");

const requiredAppSignals = ["/dashboard/stats", "/clients?", "/equipment?", "/quotes?", "/agreements", "/agents", "LoginScreen", "Run Now"];
const missingAppSignals = requiredAppSignals.filter((signal) => !app.includes(signal));

if (missingAppSignals.length > 0) {
  console.error("Smoke check failed. Missing expected App wiring:");
  missingAppSignals.forEach((signal) => console.error(`- ${signal}`));
  process.exit(1);
}

const requiredApiSignals = ["response.ok", "safeParseJson", "AbortError", "ApiError"];
const missingApiSignals = requiredApiSignals.filter((signal) => !api.includes(signal));

if (missingApiSignals.length > 0) {
  console.error("Smoke check failed. Missing expected API client behavior:");
  missingApiSignals.forEach((signal) => console.error(`- ${signal}`));
  process.exit(1);
}

console.log("Smoke check passed.");
