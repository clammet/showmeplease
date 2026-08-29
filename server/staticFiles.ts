import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { SECURITY_HEADERS } from "./http";

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

// The static export bakes absolute metadata URLs against this placeholder.
// Rewrite it when Node serves HTML directly; an external static server that
// extracts /srv/www from the image must perform the equivalent substitution.
const ORIGIN_PLACEHOLDER = "http://localhost:3000";
const HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * Public origin for absolute URLs in HTML. PUBLIC_ORIGIN wins; otherwise the
 * Host header (and, with TRUST_PROXY=1, the forwarded headers) is used after
 * a strict character check so a client cannot inject markup.
 */
export function requestOrigin(request: IncomingMessage): string {
  const configured = process.env.PUBLIC_ORIGIN?.replace(/\/+$/, "");
  if (configured) return configured;
  const trustProxy = process.env.TRUST_PROXY === "1";
  const forwardedHost = trustProxy ? request.headers["x-forwarded-host"] : undefined;
  const forwardedProto = trustProxy ? request.headers["x-forwarded-proto"] : undefined;
  const host = ((forwardedHost as string | undefined) ?? request.headers.host ?? "")
    .split(",")[0]
    .trim();
  const proto = ((forwardedProto as string | undefined) ?? "http").split(",")[0].trim();
  if (!HOST_PATTERN.test(host) || (proto !== "http" && proto !== "https")) return "";
  return `${proto}://${host}`;
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
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const clean = normalize(decoded).replace(/^([/\\])+/, "");
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
    let file = this.resolveFile(pathname);
    let status = 200;
    if (!file) {
      // Unknown paths get the exported 404 page with a real 404 status rather
      // than the app shell with a 200.
      file = this.resolveFile("404.html");
      status = 404;
      if (!file) {
        response.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain" });
        response.end("Not found");
        return;
      }
    }

    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    const immutable = pathname.startsWith("/_next/static/");

    if (type.startsWith("text/html")) {
      const origin = requestOrigin(request);
      let html = await readFile(file, "utf8");
      if (origin) html = html.replaceAll(ORIGIN_PLACEHOLDER, origin);
      response.writeHead(status, {
        ...SECURITY_HEADERS,
        "content-type": type,
        "cache-control": "no-cache",
      });
      response.end(html);
      return;
    }

    response.writeHead(status, {
      ...SECURITY_HEADERS,
      "content-type": type,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
    });
    createReadStream(file).pipe(response);
  }
}
