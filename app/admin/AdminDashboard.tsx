"use client";

import Link from "next/link";
import {
  ArrowLeft,
  Activity,
  CircleAlert,
  Cloud,
  LoaderCircle,
  LogIn,
  MonitorUp,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useOptionalAuth, type GooglyAuthClient } from "../providers";
import type { SessionOptions } from "@/lib/realtime";

type MinuteBucket = { minute: number; egressBytes: number; ingressBytes: number };

type Overview = {
  now: number;
  startedAt: number;
  sessionsCreated: number;
  wsClients: number;
  totals: { egressBytes: number; ingressBytes: number; egressBytesLastHour: number };
  series: MinuteBucket[];
  sessions: Array<{
    code: string;
    createdAt: number;
    creatorOnline: boolean;
    viewerCount: number;
    egressBytes: number;
    ingressBytes: number;
    options: SessionOptions;
  }>;
  endedSessions: Array<{
    code: string;
    createdAt: number;
    endedAt: number;
    egressBytes: number;
  }>;
  cloudflare: {
    enabled: boolean;
    egressBytes24h: number | null;
    updatedAt: number | null;
    error: string | null;
  };
};

type FetchState =
  | { phase: "loading" }
  | { phase: "unauthorized"; status: number; message: string }
  | { phase: "error"; message: string }
  | { phase: "ready"; overview: Overview };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function minuteLabel(minute: number): string {
  return new Date(minute * 60_000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatTile({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="admin-tile">
      <span className="admin-tile-icon">{icon}</span>
      <span className="admin-tile-body">
        <strong>{value}</strong>
        <span>{label}</span>
        {detail && <small>{detail}</small>}
      </span>
    </div>
  );
}

/** Per-minute SFU egress over the last hour, as a thin-bar chart with hover. */
function EgressChart({ series }: { series: MinuteBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const height = 160;
  const pad = { top: 12, right: 4, bottom: 20, left: 4 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.map((bucket) => bucket.egressBytes));
  const step = plotWidth / series.length;
  const barWidth = Math.max(2, step - 2);
  const hovered = hover !== null ? series[hover] : null;

  return (
    <div className="admin-chart">
      <div className="admin-chart-head">
        <h2>SFU egress per minute</h2>
        <span className="admin-chart-hint">
          {hovered
            ? `${minuteLabel(hovered.minute)} — ${formatBytes(hovered.egressBytes)}`
            : "last 60 minutes"}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`SFU egress per minute over the last hour, peaking at ${formatBytes(max)}`}
        onMouseLeave={() => setHover(null)}
      >
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + plotHeight / 2}
          y2={pad.top + plotHeight / 2}
          className="admin-chart-grid"
        />
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + plotHeight}
          y2={pad.top + plotHeight}
          className="admin-chart-axis"
        />
        {series.map((bucket, index) => {
          const barHeight =
            bucket.egressBytes === 0
              ? 0
              : Math.max(2, (bucket.egressBytes / max) * plotHeight);
          const x = pad.left + index * step + (step - barWidth) / 2;
          return (
            <g key={bucket.minute}>
              <rect
                x={pad.left + index * step}
                y={pad.top}
                width={step}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHover(index)}
              />
              {barHeight > 0 && (
                <rect
                  className={`admin-chart-bar ${hover === index ? "hovered" : ""}`}
                  x={x}
                  y={pad.top + plotHeight - barHeight}
                  width={barWidth}
                  height={barHeight}
                  rx={Math.min(3, barWidth / 2)}
                  pointerEvents="none"
                />
              )}
            </g>
          );
        })}
        <text className="admin-chart-label" x={pad.left} y={height - 4}>
          {minuteLabel(series[0]?.minute ?? 0)}
        </text>
        <text className="admin-chart-label" x={width - pad.right} y={height - 4} textAnchor="end">
          {minuteLabel(series[series.length - 1]?.minute ?? 0)}
        </text>
        <text className="admin-chart-label" x={width - pad.right} y={pad.top - 2} textAnchor="end">
          peak {formatBytes(max)}
        </text>
      </svg>
    </div>
  );
}

function Dashboard({ token }: { token: string | null }) {
  const [state, setState] = useState<FetchState>({ phase: "loading" });

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/overview", {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      } & Overview;
      if (!response.ok) {
        setState({
          phase: "unauthorized",
          status: response.status,
          message: payload.error || "Request failed",
        });
        return;
      }
      setState({ phase: "ready", overview: payload });
    } catch {
      setState({ phase: "error", message: "Could not reach the backend" });
    }
  }, [token]);

  useEffect(() => {
    // load() is async; state updates land after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const terminate = async (code: string) => {
    if (!window.confirm(`End session ${code} for everyone?`)) return;
    await fetch(`/api/admin/sessions/${code}`, {
      method: "DELETE",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    void load();
  };

  if (state.phase === "loading") {
    return (
      <div className="admin-empty">
        <LoaderCircle className="spin" size={22} />
        <p>Loading…</p>
      </div>
    );
  }

  if (state.phase === "unauthorized" || state.phase === "error") {
    return (
      <div className="admin-empty" role="alert">
        <CircleAlert size={22} />
        <p>{state.phase === "error" ? state.message : state.message}</p>
        {state.phase === "unauthorized" && state.status === 401 && (
          <small>Sign in with an admin Google account from the home page, then return here.</small>
        )}
      </div>
    );
  }

  const { overview } = state;
  return (
    <>
      <div className="admin-tiles">
        <StatTile
          icon={<MonitorUp size={18} />}
          label="Active sessions"
          value={String(overview.sessions.length)}
          detail={`${overview.sessionsCreated} created since start`}
        />
        <StatTile
          icon={<Users size={18} />}
          label="Connected clients"
          value={String(overview.wsClients)}
        />
        <StatTile
          icon={<Activity size={18} />}
          label="SFU egress (last hour)"
          value={formatBytes(overview.totals.egressBytesLastHour)}
          detail={`${formatBytes(overview.totals.egressBytes)} since start · ingress ${formatBytes(overview.totals.ingressBytes)}`}
        />
        <StatTile
          icon={<Cloud size={18} />}
          label="Cloudflare metered (24 h)"
          value={
            overview.cloudflare.enabled
              ? overview.cloudflare.egressBytes24h === null
                ? "…"
                : formatBytes(overview.cloudflare.egressBytes24h)
              : "off"
          }
          detail={
            overview.cloudflare.error ??
            (overview.cloudflare.enabled
              ? "from Cloudflare GraphQL analytics"
              : "set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID")
          }
        />
      </div>

      <EgressChart series={overview.series} />

      <section className="admin-card">
        <h2>Active sessions</h2>
        {overview.sessions.length === 0 ? (
          <p className="admin-muted">No active sessions.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Age</th>
                <th>Presenter</th>
                <th>Viewers</th>
                <th>Egress</th>
                <th>Ingress</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {overview.sessions.map((session) => (
                <tr key={session.code}>
                  <td className="admin-code">{session.code}</td>
                  <td>{formatDuration(overview.now - session.createdAt)}</td>
                  <td>
                    <span
                      className={`admin-badge ${session.creatorOnline ? "on" : "off"}`}
                    >
                      {session.creatorOnline ? "online" : "away"}
                    </span>
                  </td>
                  <td>{session.viewerCount}</td>
                  <td>{formatBytes(session.egressBytes)}</td>
                  <td>{formatBytes(session.ingressBytes)}</td>
                  <td>
                    <button
                      className="admin-kill"
                      onClick={() => void terminate(session.code)}
                      title="End this session for everyone"
                    >
                      <X size={14} /> End
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {overview.endedSessions.length > 0 && (
        <section className="admin-card">
          <h2>Recently ended</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Duration</th>
                <th>Ended</th>
                <th>Egress</th>
              </tr>
            </thead>
            <tbody>
              {overview.endedSessions.map((session) => (
                <tr key={`${session.code}-${session.endedAt}`}>
                  <td className="admin-code">{session.code}</td>
                  <td>{formatDuration(session.endedAt - session.createdAt)}</td>
                  <td>{formatDuration(overview.now - session.endedAt)} ago</td>
                  <td>{formatBytes(session.egressBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="admin-muted admin-footer">
        Backend up {formatDuration(overview.now - overview.startedAt)}. Egress is
        reconstructed from client WebRTC receive counters; Cloudflare&apos;s own
        metering is authoritative for billing.
      </p>
    </>
  );
}

function AuthedDashboard({ client }: { client: GooglyAuthClient }) {
  const { isLoading, isAuthenticated, token, signIn } = client.useGoogleAuth();
  if (isLoading) {
    return (
      <div className="admin-empty">
        <LoaderCircle className="spin" size={22} />
        <p>Checking sign-in…</p>
      </div>
    );
  }
  if (!isAuthenticated) {
    return (
      <div className="admin-empty">
        <p>The admin dashboard requires a Google sign-in.</p>
        <button className="button primary" onClick={() => signIn("/admin")}>
          <LogIn size={16} /> Sign in with Google
        </button>
      </div>
    );
  }
  return <Dashboard token={token} />;
}

export default function AdminDashboard() {
  const { status, client } = useOptionalAuth();

  return (
    <main className="admin-page">
      <header className="brand-bar" aria-label="Admin">
        <Link className="admin-back" href="/" aria-label="Back to app">
          <ArrowLeft size={16} />
        </Link>
        <span className="brand-mark"><MonitorUp size={17} /></span>
        <span>showmeplease admin</span>
      </header>

      {status === "loading" ? (
        <div className="admin-empty">
          <LoaderCircle className="spin" size={22} />
          <p>Loading…</p>
        </div>
      ) : status === "disabled" || !client ? (
        // No Convex auth configured; the backend may still allow access via
        // ADMIN_ALLOW_INSECURE=1 in local development.
        <Dashboard token={null} />
      ) : (
        <AuthedDashboard client={client} />
      )}
    </main>
  );
}
