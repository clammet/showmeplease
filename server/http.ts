import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(body);
}

export async function readBody(request: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  try {
    return JSON.parse(await readBody(request)) as T;
  } catch {
    return {} as T;
  }
}
