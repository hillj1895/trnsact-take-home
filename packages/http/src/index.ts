import type { Logger } from '@trnsact/core';

/** Honest, identifiable UA. In production this would carry a contact URL for dealers/site owners. */
export const DEFAULT_USER_AGENT = 'trnsact-inventory-bot/0.1 (nightly dealer inventory sync)';

export interface HttpClientOptions {
  requestsPerSecond: number;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  headers?: Record<string, string>;
  userAgent?: string;
  logger?: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchResult {
  /** Final URL after redirects. */
  url: string;
  requestedUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  fetchedAt: string;
  attempts: number;
  durationMs: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | undefined,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpStats {
  requests: number;
  retries: number;
  failures: number;
  bytes: number;
  byStatus: Record<string, number>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Polite HTTP client scoped to one source:
 *  - spaces request *starts* to at most `requestsPerSecond` (per client, i.e. per dealer)
 *  - caps in-flight requests at `concurrency`
 *  - retries transient failures with exponential backoff + jitter, honouring Retry-After
 */
export class HttpClient {
  readonly stats: HttpStats = { requests: 0, retries: 0, failures: 0, bytes: 0, byStatus: {} };
  private nextSlot = 0;
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.minIntervalMs = 1000 / opts.requestsPerSecond;
  }

  async get(url: string): Promise<FetchResult> {
    await this.acquire();
    try {
      return await this.getWithRetry(url);
    } finally {
      this.release();
    }
  }

  private async getWithRetry(url: string): Promise<FetchResult> {
    const maxAttempts = this.opts.retries + 1;
    let lastError: unknown;
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.rateLimit();
      const started = Date.now();
      let retryAfterMs: number | undefined;
      try {
        this.stats.requests++;
        const res = await this.fetchImpl(url, {
          headers: {
            'user-agent': this.opts.userAgent ?? DEFAULT_USER_AGENT,
            accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            ...this.opts.headers,
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        lastStatus = res.status;
        this.stats.byStatus[res.status] = (this.stats.byStatus[res.status] ?? 0) + 1;

        if (res.ok) {
          const body = await res.text();
          this.stats.bytes += body.length;
          return {
            url: res.url || url,
            requestedUrl: url,
            status: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            body,
            fetchedAt: new Date().toISOString(),
            attempts: attempt,
            durationMs: Date.now() - started,
          };
        }

        // Drain the body so the connection can be reused.
        await res.arrayBuffer().catch(() => undefined);
        if (!RETRYABLE_STATUS.has(res.status)) {
          throw new HttpError(`HTTP ${res.status}`, url, res.status, attempt);
        }
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        lastError = new HttpError(`HTTP ${res.status}`, url, res.status, attempt);
      } catch (err) {
        if (err instanceof HttpError && !RETRYABLE_STATUS.has(err.status ?? 0)) {
          this.stats.failures++;
          throw err;
        }
        lastError = err;
      }

      if (attempt < maxAttempts) {
        this.stats.retries++;
        const backoff = retryAfterMs ?? Math.min(30_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random());
        this.opts.logger?.warn('http.retry', {
          url,
          attempt,
          status: lastStatus,
          error: errorMessage(lastError),
          backoffMs: Math.round(backoff),
        });
        await this.sleep(backoff);
      }
    }

    this.stats.failures++;
    throw new HttpError(
      `GET failed after ${maxAttempts} attempts: ${errorMessage(lastError)}`,
      url,
      lastStatus,
      maxAttempts,
    );
  }

  /** Reserve the next start slot; callers sleep until their slot arrives. */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.opts.concurrency) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight++;
  }

  private release(): void {
    this.inFlight--;
    this.waiters.shift()?.();
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 120_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.min(date - Date.now(), 120_000));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
  return String(err);
}
