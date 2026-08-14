import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

// The static export bakes absolute metadata URLs against this placeholder;
// we rewrite it to the requesting host when serving HTML (the nginx
// sub_filter trick, moved into Node).
const ORIGIN_PLACEHOLDER = "http://localhost:3000";

function requestOrigin(request: IncomingMessage): string {
  const host =
    (request.headers["x-forwarded-host"] as string | undefined) ?? request.headers.host;
  const proto = (request.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  return host ? `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}` : "";
}

export class StaticServer {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  available(): boolean {
    return existsSync(join(this.root, "index.html"));
  }

  private resolveFile(pathname: string): string | null {
    const clean = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    const candidates = clean === "" || clean === "."
      ? ["index.html"]
      : [clean, `${clean}.html`, join(clean, "index.html")];
    for (const candidate of candidates) {
      const full = resolve(this.root, candidate);
      if (!full.startsWith(this.root + sep) && full !== this.root) continue;
      if (existsSync(full) && statSync(full).isFile()) return full;
    }
    return null;
  }

  async serve(request: IncomingMessage, response: ServerResponse, pathname: string) {
    const file = this.resolveFile(pathname) ?? this.resolveFile("index.html");
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return;
    }

    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    const immutable = pathname.startsWith("/_next/static/");

    if (type.startsWith("text/html")) {
      const origin = requestOrigin(request);
      let html = await readFile(file, "utf8");
      if (origin) html = html.replaceAll(ORIGIN_PLACEHOLDER, origin);
      response.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      response.end(html);
      return;
    }

    response.writeHead(200, {
      "content-type": type,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
    });
    createReadStream(file).pipe(response);
  }
}
