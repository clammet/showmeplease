import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Minimal dotenv: KEY=VALUE lines, optional single/double quotes, # comments.
// Never overrides variables already present in the process environment.
export function loadEnvFiles(
  files: string[] = [".env.local", ".env"],
  cwd: string = process.cwd(),
): void {
  for (const file of files) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        const hash = value.indexOf(" #");
        if (hash !== -1) value = value.slice(0, hash).trimEnd();
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
