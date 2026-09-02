"use client";

import Link from "next/link";
import {
  ArrowLeft,
  Activity,
  CircleAlert,
  Cloud,
  GitCommitHorizontal,
  LoaderCircle,
  MonitorUp,
  Users,
  X,
} from "lucide-react";
import { useConvexAuth, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalAuth, type GooglyAuthClient } from "../providers";
import { api } from "@/convex/_generated/api";
import { GIT_COMMIT } from "@/lib/buildInfo";
import type { SessionOptions } from "@/lib/realtime";

const REPOSITORY_URL = "https://github.com/clammet/showmeplease";

type MinuteBucket = { minute: number; egressBytes: number; ingressBytes: number };
type DailyBucket = { date: string; egressBytes: number };

type Overview = {
  now: number;
  startedAt: number;
  backendCommit: string | null;
  billingCycleDay: number;
  billingPeriodStart: number;
  billingPeriodEnd: number;
  sessionsCreated: number;
  wsClients: number;
  totals: {
    egressBytesBillingPeriod: number;
    ingressBytesBillingPeriod: number;
    egressBytesLastDay: number;
  };
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
    egressBytesBillingPeriod: number | null;
    dailySeries: DailyBucket[];
    billingPeriodStart: number;
    billingPeriodEnd: number;
    freeTierBytes: number;
    updatedAt: number | null;
    error: string | null;
  };
};

/**
 * What the Convex deployment reports about itself. "unconfigured" when the
 * backend has no Convex settings, "loading" until the query answers,
 * "rejected" when Convex does not recognise this sign-in as an admin.
 */
type ConvexBuild =
  | { phase: "unconfigured" }
  | { phase: "loading" }
  | { phase: "rejected" }
  | { phase: "ready"; commit: string | null };

type FetchState =
  | { phase: "loading" }
  | { phase: "unauthorized"; status: number; message: string }
  | { phase: "error"; message: string }
  | { phase: "ready"; overview: Overview };

/** Decimal units (1 GB = 10^9 B), the same scale Cloudflare bills in. */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const formatMeteredBytes = formatBytes;

function formatPercentage(ratio: number): string {
  const percentage = ratio * 100;
  if (percentage > 0 && percentage < 0.01) return "<0.01%";
  if (percentage < 10) return `${percentage.toFixed(2)}%`;
  return `${percentage.toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function minuteDateTimeLabel(minute: number): string {
  return new Date(minute * 60_000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function billingPeriodLabel(start: number, end: number): string {
  const formatter = new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}

function CommitLink({ commit }: { commit: string }) {
  return (
    <a
      className="admin-code"
      href={`${REPOSITORY_URL}/commit/${commit}`}
      target="_blank"
      rel="noreferrer"
      title={commit}
    >
      {commit.slice(0, 7)}
    </a>
  );
}

type DeploymentRow = {
  label: string;
  commit: string | null;
  status: string;
  alert: boolean;
};

/**
 * Which commit each component runs. The web bundle and backend are stamped by
 * the Docker build, the Convex functions by the deploy workflow; all three
 * should match once a deploy has finished rolling out.
 */
function DeploymentCard({
  backendCommit,
  convex,
}: {
  backendCommit: string | null;
  convex: ConvexBuild;
}) {
  const webCommit = GIT_COMMIT || null;
  const convexRow: DeploymentRow =
    convex.phase === "ready"
      ? {
          label: "Convex functions",
          commit: convex.commit,
          status: "Deployed functions",
          alert: false,
        }
      : {
          label: "Convex functions",
          commit: null,
          status:
            convex.phase === "unconfigured"
              ? "Convex is not configured"
              : convex.phase === "loading"
                ? "Loading…"
                : "Convex did not accept this sign-in as an admin",
          alert: convex.phase === "rejected",
        };
  const rows: DeploymentRow[] = [
    { label: "Web bundle", commit: webCommit, status: "This page", alert: false },
    { label: "Backend", commit: backendCommit, status: "Serving /api", alert: false },
    convexRow,
  ];
  const distinctCommits = new Set(
    rows.map((row) => row.commit).filter((commit): commit is string => commit !== null),
  );

  return (
    <section className="admin-card">
      <h2>
        <GitCommitHorizontal size={15} /> Deployment
      </h2>
      {distinctCommits.size > 1 && (
        <p className="admin-mismatch" role="status">
          Components are running different commits. A deploy may still be rolling
          out; if this persists, check the image updater and the Convex deploy
          workflow.
        </p>
      )}
      <table className="admin-table">
        <thead>
          <tr>
            <th>Component</th>
            <th>Commit</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>
                {row.commit ? (
                  <CommitLink commit={row.commit} />
                ) : (
                  <span className="admin-muted">development build</span>
                )}
              </td>
              <td className={row.alert ? "admin-alert" : undefined}>{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
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

/** Reconstructed SFU egress over the last day, as 15-minute bars. */
function EgressChart({ series }: { series: MinuteBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const height = 160;
  const pad = { top: 12, right: 4, bottom: 20, left: 4 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const peak = Math.max(0, ...series.map((bucket) => bucket.egressBytes));
  const scaleMax = Math.max(1, peak);
  const step = plotWidth / series.length;
  const barWidth = Math.max(2, step - 2);
  const hovered = hover !== null ? series[hover] : null;

  return (
    <div className="admin-chart">
      <div className="admin-chart-head">
        <h2>SFU egress per 15 minutes</h2>
        <span className="admin-chart-hint">
          {hovered
            ? `${minuteDateTimeLabel(hovered.minute)} — ${formatBytes(hovered.egressBytes)}`
            : "last 24 hours"}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`SFU egress per 15 minutes over the last day, peaking at ${formatBytes(peak)}`}
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
              : Math.max(2, (bucket.egressBytes / scaleMax) * plotHeight);
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
          {minuteDateTimeLabel(series[0]?.minute ?? 0)}
        </text>
        <text className="admin-chart-label" x={width - pad.right} y={height - 4} textAnchor="end">
          {minuteDateTimeLabel(series[series.length - 1]?.minute ?? 0)}
        </text>
        <text className="admin-chart-label" x={width - pad.right} y={pad.top - 2} textAnchor="end">
          peak {formatBytes(peak)}
        </text>
      </svg>
    </div>
  );
}

function CloudflareChart({
  usage,
  billingCycleDay,
  onBillingCycleDayChange,
}: {
  usage: Overview["cloudflare"];
  billingCycleDay: number;
  onBillingCycleDayChange: (day: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const height = 160;
  const pad = { top: 12, right: 4, bottom: 20, left: 4 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const peak = Math.max(0, ...usage.dailySeries.map((bucket) => bucket.egressBytes));
  const scaleMax = Math.max(1, peak);
  const step = usage.dailySeries.length > 0 ? plotWidth / usage.dailySeries.length : plotWidth;
  const barWidth = Math.max(3, step - 4);
  const hovered = hover !== null ? usage.dailySeries[hover] : null;
  const total = usage.egressBytesBillingPeriod ?? 0;
  const allowanceRatio = total / usage.freeTierBytes;
  const progressPercentage = Math.min(100, allowanceRatio * 100);
  const progressWidth = `${total > 0 ? Math.max(0.25, progressPercentage) : 0}%`;

  return (
    <div className="admin-chart">
      <div className="admin-chart-head">
        <h2>Cloudflare metered egress per day</h2>
        <span className="admin-chart-hint">
          {hovered
            ? `${dayLabel(hovered.date)} — ${formatMeteredBytes(hovered.egressBytes)}`
            : billingPeriodLabel(usage.billingPeriodStart, usage.billingPeriodEnd)}
        </span>
      </div>

      <div className="admin-billing-control">
        <label htmlFor="billing-cycle-day">Billing cycle starts on day</label>
        <input
          id="billing-cycle-day"
          type="number"
          min={1}
          max={31}
          value={billingCycleDay}
          onChange={(event) => {
            const day = Number(event.currentTarget.value);
            if (Number.isInteger(day) && day >= 1 && day <= 31) {
              onBillingCycleDayChange(day);
            }
          }}
        />
        <span>
          Current period {billingPeriodLabel(usage.billingPeriodStart, usage.billingPeriodEnd)}
          {usage.updatedAt !== null && `, Cloudflare data as of ${new Date(usage.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          . Saved in this browser.
        </span>
        {billingCycleDay !== 1 && (
          <button type="button" onClick={() => onBillingCycleDayChange(1)}>
            Reset to 1st
          </button>
        )}
      </div>

      {usage.enabled && usage.egressBytesBillingPeriod !== null ? (
        <>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Cloudflare metered SFU and TURN egress per day this billing period, totaling ${formatMeteredBytes(total)}`}
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
            {usage.dailySeries.map((bucket, index) => {
              const barHeight =
                bucket.egressBytes === 0
                  ? 0
                  : Math.max(2, (bucket.egressBytes / scaleMax) * plotHeight);
              const x = pad.left + index * step + (step - barWidth) / 2;
              return (
                <g key={bucket.date}>
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
                      className={`admin-chart-bar cloudflare ${hover === index ? "hovered" : ""}`}
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
              {dayLabel(usage.dailySeries[0]?.date ?? "1970-01-01")}
            </text>
            <text
              className="admin-chart-label"
              x={width - pad.right}
              y={height - 4}
              textAnchor="end"
            >
              {dayLabel(usage.dailySeries[usage.dailySeries.length - 1]?.date ?? "1970-01-01")}
            </text>
            <text
              className="admin-chart-label"
              x={width - pad.right}
              y={pad.top - 2}
              textAnchor="end"
            >
              peak {formatMeteredBytes(peak)}
            </text>
          </svg>
          <div className="admin-usage-head">
            <span>{formatMeteredBytes(total)} of 1 TB free</span>
            <strong>{formatPercentage(allowanceRatio)}</strong>
          </div>
          <div
            className="admin-usage-track"
            role="progressbar"
            aria-label="Cloudflare monthly free egress allowance used"
            aria-valuemin={0}
            aria-valuemax={usage.freeTierBytes}
            aria-valuenow={Math.min(total, usage.freeTierBytes)}
          >
            <span style={{ width: progressWidth }} />
          </div>
          {usage.error && <p className="admin-chart-error">Last refresh failed: {usage.error}</p>}
        </>
      ) : (
        <p className="admin-muted admin-chart-empty">
          {usage.enabled
            ? usage.error ?? "Waiting for Cloudflare analytics…"
            : "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to load this graph."}
        </p>
      )}
    </div>
  );
}

function Dashboard({
  token,
  convex,
  onUnauthorized,
}: {
  token: string | null;
  convex: ConvexBuild;
  onUnauthorized?: () => void;
}) {
  const [state, setState] = useState<FetchState>({ phase: "loading" });
  const [billingCycleDay, setBillingCycleDay] = useState(() => {
    if (typeof window === "undefined") return 1;
    const stored = Number(window.localStorage.getItem("showmeplease.billingCycleDay"));
    return Number.isInteger(stored) && stored >= 1 && stored <= 31 ? stored : 1;
  });

  const updateBillingCycleDay = useCallback((day: number) => {
    setBillingCycleDay(day);
    window.localStorage.setItem("showmeplease.billingCycleDay", String(day));
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/overview?billingCycleDay=${billingCycleDay}`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      } & Overview;
      if (!response.ok) {
        if (response.status === 401 && onUnauthorized) {
          onUnauthorized();
          return;
        }
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
  }, [token, onUnauthorized, billingCycleDay]);

  useEffect(() => {
    // load() is async; state updates land after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const terminate = async (code: string) => {
    if (!window.confirm(`End session ${code} for everyone?`)) return;
    try {
      const response = await fetch(`/api/admin/sessions/${code}`, {
        method: "DELETE",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        window.alert(`Could not end ${code}: ${payload.error ?? response.status}`);
      }
    } catch {
      window.alert(`Could not end ${code}: backend unreachable`);
    }
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
          <small>Google sign-in is not configured for this deployment.</small>
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
          label="SFU egress (last day)"
          value={formatBytes(overview.totals.egressBytesLastDay)}
          detail={`${formatBytes(overview.totals.egressBytesBillingPeriod)} since billing period start · ingress ${formatBytes(overview.totals.ingressBytesBillingPeriod)}`}
        />
        <StatTile
          icon={<Cloud size={18} />}
          label="Cloudflare metered (billing period)"
          value={
            overview.cloudflare.enabled
              ? overview.cloudflare.egressBytesBillingPeriod === null
                ? "…"
                : formatMeteredBytes(overview.cloudflare.egressBytesBillingPeriod)
              : "off"
          }
          detail={
            overview.cloudflare.error ??
            (overview.cloudflare.enabled
              ? `${formatPercentage((overview.cloudflare.egressBytesBillingPeriod ?? 0) / overview.cloudflare.freeTierBytes)} of the 1 TB free tier`
              : "set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID")
          }
        />
      </div>

      <EgressChart series={overview.series} />
      <CloudflareChart
        usage={overview.cloudflare}
        billingCycleDay={overview.billingCycleDay}
        onBillingCycleDayChange={updateBillingCycleDay}
      />

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

      <DeploymentCard backendCommit={overview.backendCommit} convex={convex} />

      <p className="admin-muted admin-footer">
        Backend up {formatDuration(overview.now - overview.startedAt)}. Egress is
        reconstructed from client WebRTC receive counters; Cloudflare&apos;s own
        analytics are the closest billing estimate; the invoice remains authoritative.
      </p>
    </>
  );
}

function AuthedDashboard({ client }: { client: GooglyAuthClient }) {
  const { isLoading, isAuthenticated, token, signIn, signOut } = client.useGoogleAuth();
  // Convex learns about the Google token a moment after the client does;
  // hold the query until then so it is not issued anonymously and refused.
  const { isAuthenticated: convexAuthenticated } = useConvexAuth();
  const deployment = useQuery(api.system.deploymentStatus, convexAuthenticated ? {} : "skip");
  const convex: ConvexBuild =
    deployment === undefined
      ? { phase: "loading" }
      : deployment === null
        ? { phase: "rejected" }
        : { phase: "ready", commit: deployment.commit };
  const signInStarted = useRef(false);
  const [rejected, setRejected] = useState(false);
  const startSignIn = useCallback(() => {
    if (signInStarted.current) {
      // Already redirected once this page load and still 401: the token the
      // backend sees is not acceptable, so stop looping and say so.
      setRejected(true);
      return;
    }
    signInStarted.current = true;
    signIn("/admin");
  }, [signIn]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) startSignIn();
  }, [isAuthenticated, isLoading, startSignIn]);

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
        <LoaderCircle className="spin" size={22} />
        <p>Redirecting to sign-in…</p>
      </div>
    );
  }
  if (rejected) {
    return (
      <div className="admin-empty" role="alert">
        <CircleAlert size={22} />
        <p>The backend rejected this sign-in.</p>
        <small>Check AUTH_GOOGLE_ID matches the Convex deployment, then sign in again.</small>
        <button type="button" onClick={() => signOut()}>Sign out</button>
      </div>
    );
  }
  return <Dashboard token={token} convex={convex} onUnauthorized={startSignIn} />;
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
        <Dashboard token={null} convex={{ phase: "unconfigured" }} />
      ) : (
        <AuthedDashboard client={client} />
      )}
    </main>
  );
}
