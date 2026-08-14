"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { LogIn, LogOut, ShieldCheck } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useOptionalAuth, type GooglyAuthClient } from "./providers";

function SignedControls({ client }: { client: GooglyAuthClient }) {
  const { isLoading, isAuthenticated, signIn, signOut } = client.useGoogleAuth();
  const claim = client.useAnonymousClaim();
  const profile = useQuery(api.users.currentProfile, {
    anonymousClaim: isAuthenticated ? undefined : (claim ?? undefined),
  });

  if (isLoading) return null;

  if (!isAuthenticated) {
    return (
      <button className="account-button" onClick={() => signIn()} title="Sign in with Google">
        <LogIn size={15} />
        Sign in
      </button>
    );
  }

  return (
    <span className="account-cluster">
      {profile?.isAdmin && (
        <Link className="account-button" href="/admin" title="Admin dashboard">
          <ShieldCheck size={15} />
          Admin
        </Link>
      )}
      <span className="account-name" title={profile?.email ?? undefined}>
        {profile?.displayName ?? "Signed in"}
      </span>
      <button className="account-button" onClick={() => signOut()} title="Sign out">
        <LogOut size={15} />
      </button>
    </span>
  );
}

/** Sign-in/out cluster for the landing header; renders nothing when auth is disabled. */
export default function AccountControls() {
  const { status, client } = useOptionalAuth();
  if (status !== "ready" || !client) return null;
  return <SignedControls client={client} />;
}
