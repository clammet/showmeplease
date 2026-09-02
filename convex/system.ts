import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { isAdmin } from "./access.js";
import { GIT_COMMIT } from "./buildInfo.js";

// Which commit the deployed functions were built from, for the admin
// dashboard's deployment card. Returns null for callers who are not admins
// instead of throwing so a mismatched ADMIN_EMAILS between the container and
// this deployment shows up as a labelled row rather than a crashed page.
export const deploymentStatus = query({
  args: {},
  returns: v.union(v.object({ commit: v.union(v.string(), v.null()) }), v.null()),
  handler: async (ctx) => {
    if (!(await isAdmin(ctx))) return null;
    return { commit: GIT_COMMIT || null };
  },
});
