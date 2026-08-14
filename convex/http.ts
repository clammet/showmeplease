import { httpRouter } from "convex/server";
import { GooglyAuth } from "@clammet/convex-googly-auth";
import { components } from "./_generated/api.js";

const http = httpRouter();

const googly = new GooglyAuth(components.googlyAuth);
// Reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET / SITE_URL from the deployment
// environment. Mounts GET /auth/google/start, GET /auth/google/callback,
// POST /auth/refresh, POST /auth/sign-out.
googly.registerRoutes(http);

export default http;
