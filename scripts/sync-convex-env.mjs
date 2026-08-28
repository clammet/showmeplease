#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env.local");

function envValue(content, key) {
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].replace(/^(["'])(.*)\1$/, "$2") : null;
}

if (!existsSync(envPath)) {
  console.error("Missing .env.local. Run `pnpm devsetup` first.");
  process.exit(1);
}

const env = readFileSync(envPath, "utf8");
const deployment = envValue(env, "CONVEX_DEPLOYMENT") ?? "";
if (!deployment.startsWith("anonymous:") && !deployment.startsWith("local:")) {
  console.error(
    `Refusing to automatically update Convex env vars for non-local deployment ${deployment || "(unknown)"}.`,
  );
  process.exit(1);
}

const values = {
  SITE_URL: envValue(env, "SITE_URL") || "http://127.0.0.1:3000",
  AUTH_GOOGLE_ID:
    envValue(env, "AUTH_GOOGLE_ID") || "placeholder.apps.googleusercontent.com",
  AUTH_GOOGLE_SECRET: envValue(env, "AUTH_GOOGLE_SECRET") || "",
  ADMIN_EMAILS: envValue(env, "ADMIN_EMAILS") || "",
};

const temporaryDirectory = mkdtempSync(join(tmpdir(), "showmeplease-convex-env-"));
const temporaryEnv = join(temporaryDirectory, "env");

try {
  writeFileSync(
    temporaryEnv,
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );

  const result = spawnSync(
    "npx",
    ["convex", "env", "set", "--force", "--from-file", temporaryEnv],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
    },
  );
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

if (!process.exitCode) {
  console.log("Local Convex auth environment synchronized.");
}
