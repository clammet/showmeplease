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
// provide Cloudflare-side usage analytics closest to the billed traffic.

export type MinuteBucket = { minute: number; egressBytes: number; ingressBytes: number };

export type CloudflareDailyBucket = { date: string; egressBytes: number };

// Retain enough sparse minute buckets for both a 31-day billing period and a
// rolling 24-hour view. Empty minutes are only materialized in API responses.
const SERIES_MINUTES = 32 * 24 * 60;
const DAY_MS = 24 * 60 * 60_000;
const USAGE_LOOKBACK_DAYS = 31;

function cloudflareErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Cloudflare analytics request failed";
  return message.replace(/account "[a-f0-9]{32}"/gi, "Cloudflare account");
}

export const CLOUDFLARE_FREE_TIER_BYTES = 1_000_000_000_000;

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function utcCycleDate(year: number, month: number, cycleDay: number): number {
  return Date.UTC(year, month, Math.min(cycleDay, daysInUtcMonth(year, month)));
}

export function utcBillingPeriod(
  cycleDay: number,
  now = Date.now(),
): { start: number; end: number } {
  const safeCycleDay =
    Number.isInteger(cycleDay) && cycleDay >= 1 && cycleDay <= 31 ? cycleDay : 1;
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const thisMonthStart = utcCycleDate(year, month, safeCycleDay);
  if (thisMonthStart <= now) {
    return {
      start: thisMonthStart,
      end: utcCycleDate(year, month + 1, safeCycleDay),
    };
  }
  return {
    start: utcCycleDate(year, month - 1, safeCycleDay),
    end: thisMonthStart,
  };
}

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

  /** Dense series for the requested period, oldest first. */
  series(minutes = 60, bucketMinutes = 1, now = Date.now()): MinuteBucket[] {
    const end = Math.floor(now / 60_000);
    const safeBucketMinutes = Math.max(1, Math.floor(bucketMinutes));
    const endBucket = Math.floor(end / safeBucketMinutes) * safeBucketMinutes;
    const bucketCount = Math.ceil(minutes / safeBucketMinutes);
    const startBucket = endBucket - (bucketCount - 1) * safeBucketMinutes;
    const byMinute = new Map<number, MinuteBucket>();
    for (const bucket of this.buckets) {
      const minute = Math.floor(bucket.minute / safeBucketMinutes) * safeBucketMinutes;
      if (minute < startBucket || minute > endBucket) continue;
      const aggregate = byMinute.get(minute);
      if (aggregate) {
        aggregate.egressBytes += bucket.egressBytes;
        aggregate.ingressBytes += bucket.ingressBytes;
      } else {
        byMinute.set(minute, { ...bucket, minute });
      }
    }
    const result: MinuteBucket[] = [];
    for (let minute = startBucket; minute <= endBucket; minute += safeBucketMinutes) {
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

  bytesSince(since: number): { egressBytes: number; ingressBytes: number } {
    const firstMinute = Math.ceil(since / 60_000);
    return this.buckets
      .filter((bucket) => bucket.minute >= firstMinute)
      .reduce(
        (totals, bucket) => ({
          egressBytes: totals.egressBytes + bucket.egressBytes,
          ingressBytes: totals.ingressBytes + bucket.ingressBytes,
        }),
        { egressBytes: 0, ingressBytes: 0 },
      );
  }
}

export type CloudflareUsage = {
  enabled: boolean;
  /** Account-wide Realtime SFU + TURN egress for the selected billing period. */
  egressBytesBillingPeriod: number | null;
  dailySeries: CloudflareDailyBucket[];
  billingPeriodStart: number;
  billingPeriodEnd: number;
  freeTierBytes: number;
  updatedAt: number | null;
  error: string | null;
};

type CloudflareUsageState = {
  enabled: boolean;
  dailySeries: CloudflareDailyBucket[];
  updatedAt: number | null;
  error: string | null;
};

type CloudflarePollerOptions = {
  apiToken: string;
  accountId: string;
  intervalMs?: number;
};

const USAGE_QUERY = `
  query RealtimeUsage($accountTag: string!, $since: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        sfu: callsUsageAdaptiveGroups(
          filter: { date_geq: $since }
          limit: 100
          orderBy: [date_ASC]
        ) {
          dimensions {
            date
          }
          sum {
            egressBytes
          }
        }
        turn: callsTurnUsageAdaptiveGroups(
          filter: { date_geq: $since }
          limit: 100
          orderBy: [date_ASC]
        ) {
          dimensions {
            date
          }
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
  private state: CloudflareUsageState = {
    enabled: true,
    dailySeries: [],
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

  snapshot(billingPeriodStart: number, billingPeriodEnd: number): CloudflareUsage {
    const startDate = new Date(billingPeriodStart).toISOString().slice(0, 10);
    const endDate = new Date(billingPeriodEnd).toISOString().slice(0, 10);
    const dailySeries = this.state.dailySeries.filter(
      (bucket) => bucket.date >= startDate && bucket.date < endDate,
    );
    return {
      enabled: this.state.enabled,
      egressBytesBillingPeriod:
        this.state.updatedAt === null
          ? null
          : dailySeries.reduce((sum, bucket) => sum + bucket.egressBytes, 0),
      dailySeries,
      billingPeriodStart,
      billingPeriodEnd,
      freeTierBytes: CLOUDFLARE_FREE_TIER_BYTES,
      updatedAt: this.state.updatedAt,
      error: this.state.error,
    };
  }

  private async poll() {
    const now = Date.now();
    try {
      const rangeStart = now - USAGE_LOOKBACK_DAYS * DAY_MS;
      const since = new Date(rangeStart).toISOString().slice(0, 10);
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
            since,
          },
        }),
      });
      const payload = (await response.json()) as {
        data?: {
          viewer?: {
            accounts?: Array<{
              sfu?: Array<{
                dimensions?: { date?: string };
                sum?: { egressBytes?: number };
              }>;
              turn?: Array<{
                dimensions?: { date?: string };
                sum?: { egressBytes?: number };
              }>;
            }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };
      if (!response.ok) {
        throw new Error(`Cloudflare analytics request failed (${response.status})`);
      }
      if (payload.errors?.length) {
        throw new Error(payload.errors.map((error) => error.message).join("; "));
      }
      const account = payload.data?.viewer?.accounts?.[0];
      const groups = [...(account?.sfu ?? []), ...(account?.turn ?? [])];
      const byDate = new Map<string, number>();
      for (const group of groups) {
        const date = group.dimensions?.date;
        const egressBytes = group.sum?.egressBytes;
        if (!date || typeof egressBytes !== "number" || !Number.isFinite(egressBytes)) continue;
        byDate.set(date, (byDate.get(date) ?? 0) + Math.max(0, egressBytes));
      }

      const dailySeries: CloudflareDailyBucket[] = [];
      const firstDay = Date.parse(`${since}T00:00:00Z`);
      for (let day = firstDay; day <= now; day += DAY_MS) {
        const date = new Date(day).toISOString().slice(0, 10);
        dailySeries.push({ date, egressBytes: byDate.get(date) ?? 0 });
      }
      this.state = {
        enabled: true,
        dailySeries,
        updatedAt: now,
        error: null,
      };
    } catch (error) {
      this.state = {
        ...this.state,
        error: cloudflareErrorMessage(error),
      };
    }
  }
}
