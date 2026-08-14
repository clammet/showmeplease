// Egress accounting for the Cloudflare Realtime SFU.
//
// Primary source: clients periodically report their RTCPeerConnection byte
// counters over the session WebSocket. Every byte a client *receives* was
// egressed by the SFU, and every byte a client *sends* is SFU ingress, so
// summing the reported deltas across all connected clients reconstructs the
// SFU's billable traffic without needing Cloudflare API credentials.
//
// Secondary (optional) source: the Cloudflare GraphQL Analytics dataset
// `callsUsageAdaptiveGroups`, polled when CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID are configured. Analytics lag by a few minutes but
// reflect Cloudflare's own metering.

export type MinuteBucket = { minute: number; egressBytes: number; ingressBytes: number };

const SERIES_MINUTES = 180;

export class EgressLedger {
  totalEgressBytes = 0;
  totalIngressBytes = 0;
  private buckets: MinuteBucket[] = [];

  record(egressDelta: number, ingressDelta: number, now = Date.now()) {
    if (egressDelta <= 0 && ingressDelta <= 0) return;
    this.totalEgressBytes += Math.max(0, egressDelta);
    this.totalIngressBytes += Math.max(0, ingressDelta);
    const minute = Math.floor(now / 60_000);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.minute === minute) {
      last.egressBytes += Math.max(0, egressDelta);
      last.ingressBytes += Math.max(0, ingressDelta);
    } else {
      this.buckets.push({
        minute,
        egressBytes: Math.max(0, egressDelta),
        ingressBytes: Math.max(0, ingressDelta),
      });
      if (this.buckets.length > SERIES_MINUTES) {
        this.buckets.splice(0, this.buckets.length - SERIES_MINUTES);
      }
    }
  }

  /** Dense per-minute series for the last `minutes` minutes, oldest first. */
  series(minutes = 60, now = Date.now()): MinuteBucket[] {
    const end = Math.floor(now / 60_000);
    const byMinute = new Map(this.buckets.map((bucket) => [bucket.minute, bucket]));
    const result: MinuteBucket[] = [];
    for (let minute = end - minutes + 1; minute <= end; minute += 1) {
      result.push(byMinute.get(minute) ?? { minute, egressBytes: 0, ingressBytes: 0 });
    }
    return result;
  }

  bytesInLast(minutes: number, now = Date.now()): number {
    const cutoff = Math.floor(now / 60_000) - minutes;
    return this.buckets
      .filter((bucket) => bucket.minute > cutoff)
      .reduce((sum, bucket) => sum + bucket.egressBytes, 0);
  }
}

export type CloudflareUsage = {
  enabled: boolean;
  /** Egress bytes metered by Cloudflare in the last 24 hours. */
  egressBytes24h: number | null;
  updatedAt: number | null;
  error: string | null;
};

type CloudflarePollerOptions = {
  apiToken: string;
  accountId: string;
  appId: string;
  intervalMs?: number;
};

const USAGE_QUERY = `
  query SfuUsage($accountTag: string!, $appId: string!, $since: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        callsUsageAdaptiveGroups(
          filter: { appId: $appId, datetimeMinute_gt: $since }
          limit: 1000
        ) {
          sum {
            egressBytes
          }
        }
      }
    }
  }
`;

export class CloudflareUsagePoller {
  private readonly options: CloudflarePollerOptions;
  private timer: NodeJS.Timeout | null = null;
  private state: CloudflareUsage = {
    enabled: true,
    egressBytes24h: null,
    updatedAt: null,
    error: null,
  };

  constructor(options: CloudflarePollerOptions) {
    this.options = options;
  }

  start() {
    const interval = this.options.intervalMs ?? 5 * 60_000;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), interval);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): CloudflareUsage {
    return { ...this.state };
  }

  private async poll() {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: USAGE_QUERY,
          variables: {
            accountTag: this.options.accountId,
            appId: this.options.appId,
            since,
          },
        }),
      });
      const payload = (await response.json()) as {
        data?: {
          viewer?: {
            accounts?: Array<{
              callsUsageAdaptiveGroups?: Array<{ sum?: { egressBytes?: number } }>;
            }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };
      if (payload.errors?.length) {
        throw new Error(payload.errors.map((error) => error.message).join("; "));
      }
      const groups = payload.data?.viewer?.accounts?.[0]?.callsUsageAdaptiveGroups ?? [];
      const total = groups.reduce((sum, group) => sum + (group.sum?.egressBytes ?? 0), 0);
      this.state = { enabled: true, egressBytes24h: total, updatedAt: Date.now(), error: null };
    } catch (error) {
      this.state = {
        ...this.state,
        error: error instanceof Error ? error.message : "Cloudflare analytics request failed",
      };
    }
  }
}
