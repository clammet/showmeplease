import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // The googly-auth component owns credentials; the app only keys profiles by
  // the opaque identity id it hands out.
  profiles: defineTable({
    identityId: v.string(),
    displayName: v.string(),
    email: v.optional(v.string()),
    isAnonymous: v.boolean(),
  }).index("by_identityId", ["identityId"]),
});
