#!/usr/bin/env node
// Sets up a complete local development environment:
//   - installs dependencies
//   - initializes an anonymous *local* Convex deployment (a real Convex
//     backend running on this machine, managed by the Convex CLI)
//   - writes/extends .env.local with the backend + Convex settings
//   - pushes the Convex functions once and forwards auth env vars
//
// Idempotent: safe to re-run at any time.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env.local");

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CONVEX_AGENT_MODE: "anonymous", ...options.env },
  });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(" ")} failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

function readEnvFile() {
  return existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
}

function envValue(content, key) {
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].replace(/^["']|["']$/g, "") : null;
}

function ensureEnvValues(pairs) {
  let content = readEnvFile();
  if (content && !content.endsWith("\n")) content += "\n";
  const added = [];
  for (const [key, value, comment] of pairs) {
    if (envValue(content, key) !== null) continue;
    if (comment) content += `# ${comment}\n`;
    content += `${key}=${value}\n`;
    added.push(key);
  }
  writeFileSync(envPath, content);
  return added;
}

console.log("showmeplease dev setup\n======================");

// 1. Dependencies.
run("pnpm", ["install"]);

// 2. Anonymous local Convex deployment (no account needed; state lives under
//    ~/.convex). `convex init` is a no-op when already configured.
run("npx", ["convex", "init"]);

// 3. Local environment for the Node backend and Convex CLI.
const added = ensureEnvValues([
  ["VITE_CONVEX_URL", "http://127.0.0.1:3210", "Convex deployment (local instance from `npx convex dev`)"],
  ["VITE_CONVEX_SITE_URL", "http://127.0.0.1:3211", "Convex HTTP actions (auth routes)"],
  ["ADMIN_ALLOW_INSECURE", "1", "Local-only: open /admin without Google sign-in. Never set in production."],
  ["REALTIME_APP_ID", '""', "Cloudflare Realtime SFU app (media relay will 503 until set)"],
  ["REALTIME_APP_SECRET", '""'],
  ["AUTH_GOOGLE_ID", '""', "Google OAuth client (sign-in stays disabled until set)"],
  ["AUTH_GOOGLE_SECRET", '""'],
  ["ADMIN_EMAILS", '""', "Comma-separated Google account emails allowed on /admin"],
]);
if (added.length) console.log(`\nAdded to .env.local: ${added.join(", ")}`);

// 4. Forward auth configuration into the local Convex deployment without
//    putting secret values in process arguments or terminal output.
run(process.execPath, ["scripts/sync-convex-env.mjs"]);

// 5. Push functions to the local deployment (starts the local backend for the
//    duration of the push) and generate convex/_generated.
run("npx", ["convex", "dev", "--once"]);

console.log(`
Done. Next steps:

  pnpm dev          # starts local Convex + Node backend (:8787) + web (:3000)
  open http://127.0.0.1:3000        (app)
  open http://127.0.0.1:3000/admin  (admin dashboard)

Optional, in .env.local:
  - REALTIME_APP_ID / REALTIME_APP_SECRET   -> enables the Cloudflare SFU media relay
  - AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET     -> enables Google sign-in (pnpm dev
    forwards changes into the local Convex deployment on every startup)
  - ADMIN_EMAILS                            -> admin allowlist (then remove ADMIN_ALLOW_INSECURE)
  - CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID -> Cloudflare-metered egress in /admin
`);
