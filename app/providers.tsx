"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ConvexProviderWithAuth,
  ConvexReactClient,
  useMutation,
} from "convex/react";
import { createGooglyAuthClient } from "@clammet/convex-googly-auth/react";
import { api } from "@/convex/_generated/api";

export type AuthConfig = {
  convexUrl: string;
  convexSiteUrl: string;
  googleClientId: string;
};

export type GooglyAuthClient = ReturnType<typeof createGooglyAuthClient>;

type AuthContextValue = {
  /** "loading" until /api/config answers; "disabled" when Convex auth is not configured. */
  status: "loading" | "disabled" | "ready";
  client: GooglyAuthClient | null;
};

const AuthContext = createContext<AuthContextValue>({ status: "loading", client: null });

export function useOptionalAuth(): AuthContextValue {
  return useContext(AuthContext);
}

// The static export carries no build-time secrets; the backend hands the
// frontend its Convex/Google configuration at runtime.
let configPromise: Promise<{ auth: AuthConfig | null }> | null = null;
function fetchAppConfig() {
  configPromise ??= fetch("/api/config")
    .then((response) => (response.ok ? response.json() : { auth: null }))
    .catch(() => ({ auth: null }));
  return configPromise;
}

let cachedClient: GooglyAuthClient | null = null;
function getAuthClient(config: AuthConfig): GooglyAuthClient {
  cachedClient ??= createGooglyAuthClient({
    convexSiteUrl: config.convexSiteUrl,
    googleClientId: config.googleClientId,
    storagePrefix: "showmeplease",
  });
  return cachedClient;
}

/** Keeps the Convex profile row in sync with the signed-in (or anonymous) user. */
function ProfileSync({ client }: { client: GooglyAuthClient }) {
  const { isLoading, isAuthenticated } = client.useGoogleAuth();
  const claim = client.useAnonymousClaim();
  const ensureProfile = useMutation(api.users.ensureProfile);

  useEffect(() => {
    if (isLoading) return;
    // Pass the claim even when signed in so a pre-sign-in anonymous profile
    // is upgraded/merged, then retire it client-side.
    void ensureProfile({ anonymousClaim: claim ?? undefined })
      .then(() => {
        if (isAuthenticated) client.clearAnonymousClaim();
      })
      .catch(() => undefined);
  }, [ensureProfile, claim, isAuthenticated, isLoading, client]);

  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthConfig | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void fetchAppConfig().then((config) => {
      if (!cancelled) setAuth(config.auth);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const client = auth ? getAuthClient(auth) : null;
  const convex = useMemo(
    () => (auth ? new ConvexReactClient(auth.convexUrl) : null),
    [auth],
  );

  if (!auth || !client || !convex) {
    return (
      <AuthContext.Provider
        value={{ status: auth === undefined ? "loading" : "disabled", client: null }}
      >
        {children}
      </AuthContext.Provider>
    );
  }

  return (
    <AuthContext.Provider value={{ status: "ready", client }}>
      <client.GoogleAuthProvider>
        <ConvexProviderWithAuth client={convex} useAuth={client.useConvexGooglyAuth}>
          <ProfileSync client={client} />
          {children}
        </ConvexProviderWithAuth>
      </client.GoogleAuthProvider>
    </AuthContext.Provider>
  );
}
