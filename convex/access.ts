import type { QueryCtx } from "./_generated/server.js";

export function isAdminEmail(email: string | undefined): boolean {
  if (!email) return false;
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

// Admins are recognised by the verified email on the Google ID token, the
// same check the Node backend applies to /api/admin, so a profile row is not
// required. Anonymous identities never qualify.
export async function isAdmin(ctx: QueryCtx): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null || identity.emailVerified !== true) return false;
  return isAdminEmail(identity.email);
}
