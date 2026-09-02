import { GooglyAuth } from "@clammet/convex-googly-auth";
import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { mutation, query } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { isAdminEmail } from "./access.js";

const googly = new GooglyAuth(components.googlyAuth);

async function profileByIdentityId(
  ctx: QueryCtx,
  identityId: string,
): Promise<Doc<"profiles"> | null> {
  return await ctx.db
    .query("profiles")
    .withIndex("by_identityId", (q) => q.eq("identityId", identityId))
    .unique();
}

async function absorbProfile(ctx: MutationCtx, mergedFromId: string): Promise<void> {
  const absorbed = await profileByIdentityId(ctx, mergedFromId);
  if (absorbed !== null) {
    await ctx.db.delete("profiles", absorbed._id);
  }
}

export const ensureProfile = mutation({
  args: { anonymousClaim: v.optional(v.string()) },
  returns: v.id("profiles"),
  handler: async (ctx, args): Promise<Id<"profiles">> => {
    const result = await googly.ensureIdentity(ctx, args);
    const existing = await profileByIdentityId(ctx, result.identityId);
    let profileId: Id<"profiles">;
    if (existing === null) {
      profileId = await ctx.db.insert("profiles", {
        identityId: result.identityId,
        displayName: result.identity?.name ?? "Anonymous",
        email: result.identity?.email,
        isAnonymous: result.identity === null,
      });
    } else {
      await ctx.db.patch("profiles", existing._id, {
        displayName: result.identity?.name ?? existing.displayName,
        email: result.identity?.email ?? existing.email,
        isAnonymous: result.identity === null,
      });
      profileId = existing._id;
    }
    if (result.mergedFromId !== null) {
      await absorbProfile(ctx, result.mergedFromId);
    }
    return profileId;
  },
});

const publicProfileValidator = v.object({
  displayName: v.string(),
  email: v.optional(v.string()),
  isAnonymous: v.boolean(),
  isAdmin: v.boolean(),
});

export const currentProfile = query({
  args: { anonymousClaim: v.optional(v.string()) },
  returns: v.union(publicProfileValidator, v.null()),
  handler: async (ctx, args) => {
    const identityId = await googly.resolveIdentity(ctx, {
      anonymousClaim: args.anonymousClaim,
    });
    if (identityId === null) return null;
    const profile = await profileByIdentityId(ctx, identityId);
    if (profile === null) return null;
    return {
      displayName: profile.displayName,
      email: profile.email,
      isAnonymous: profile.isAnonymous,
      isAdmin: !profile.isAnonymous && isAdminEmail(profile.email),
    };
  },
});
