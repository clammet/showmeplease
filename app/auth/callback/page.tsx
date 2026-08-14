"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { useOptionalAuth } from "../../providers";

export default function AuthCallbackPage() {
  const { status, client } = useOptionalAuth();
  const handled = useRef(false);

  useEffect(() => {
    if (status !== "ready" || !client || handled.current) return;
    handled.current = true;
    const result = client.handleAuthCallback();
    if (result.error !== null) {
      console.warn("Sign-in failed:", result.error);
    }
    window.location.replace(result.redirect);
  }, [status, client]);

  return (
    <main className="landing-page">
      <section className="start-panel auth-callback">
        <LoaderCircle className="spin" size={22} />
        <p>{status === "disabled" ? "Sign-in is not configured." : "Signing in…"}</p>
      </section>
    </main>
  );
}
