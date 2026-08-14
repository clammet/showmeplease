import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Admin requests carry the Google ID token minted through convex-googly-auth
// as a Bearer token. We verify it against Google's JWKS directly, so the
// backend needs no session state of its own — just the OAuth client id
// (audience) and an allowlist of admin email addresses.

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

export type AdminCheck =
  | { ok: true; email: string }
  | { ok: false; status: number; error: string };

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export async function checkAdmin(request: IncomingMessage): Promise<AdminCheck> {
  // Local development escape hatch; never set in production.
  if (process.env.ADMIN_ALLOW_INSECURE === "1") {
    return { ok: true, email: "dev@localhost" };
  }

  const clientId = process.env.AUTH_GOOGLE_ID;
  const allowed = adminEmails();
  if (!clientId || allowed.length === 0) {
    return {
      ok: false,
      status: 503,
      error: "Admin access is not configured (AUTH_GOOGLE_ID / ADMIN_EMAILS)",
    };
  }

  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: "Missing bearer token" };

  try {
    const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    if (!email || payload.email_verified !== true) {
      return { ok: false, status: 403, error: "Google account has no verified email" };
    }
    if (!allowed.includes(email)) {
      return { ok: false, status: 403, error: "This account is not an admin" };
    }
    return { ok: true, email };
  } catch {
    return { ok: false, status: 401, error: "Invalid or expired token" };
  }
}
