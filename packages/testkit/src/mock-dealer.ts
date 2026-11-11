import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { seedInventory, type MockUnit } from './inventory.js';
import { detailPath, renderDetailPage, renderListPage, type Layout } from './transwest-templates.js';

/**
 * A fake dealer website on a random localhost port, serving Transwest-shaped
 * HTML from an in-memory inventory. Tests point the REAL source config at it
 * (only `baseUrl` changes), mutate inventory between "nights", and inject
 * faults — so every change-detection path can be exercised end to end through
 * HTTP → extract → normalize → persist → apply, deterministically, in seconds.
 */
export interface MockDealerOptions {
  inventory?: MockUnit[];
  /** Cards per list page (real site: 19). */
  pageSize?: number;
  layout?: Layout;
  /**
   * What an out-of-range `?page=N` returns. `'empty'`: no cards. `'first-page'`:
   * the server ignores the param and repeats page 1 (a real-world failure mode
   * the driver's "no new keys" guard must catch).
   */
  outOfRangePage?: 'empty' | 'first-page';
}

export interface FaultOptions {
  status?: number;
  /** How many matching requests fail before the fault clears (default: forever). */
  times?: number;
  /** Retry-After header; '0' keeps test retries instant. */
  retryAfter?: string;
}

interface Fault extends Required<Omit<FaultOptions, 'times'>> {
  match: (path: string) => boolean;
  remaining: number;
}

export interface RequestLogEntry {
  path: string;
  status: number;
  userAgent?: string;
}

const LIST_PATHS: Record<string, MockUnit['group']> = {
  '/trucks/type/all/store/': 'trucks',
  '/trailers/type/all/store/': 'trailers',
};

export class MockDealer {
  inventory: MockUnit[];
  pageSize: number;
  layout: Layout;
  outOfRangePage: 'empty' | 'first-page';
  readonly requests: RequestLogEntry[] = [];
  private faults: Fault[] = [];
  private night = 0;
  private server?: Server;
  private baseUrl?: string;

  constructor(opts: MockDealerOptions = {}) {
    this.inventory = opts.inventory ?? seedInventory();
    this.pageSize = opts.pageSize ?? 10;
    this.layout = opts.layout ?? 'current';
    this.outOfRangePage = opts.outOfRangePage ?? 'empty';
  }

  get url(): string {
    if (!this.baseUrl) throw new Error('MockDealer not started');
    return this.baseUrl;
  }

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  /** Advance the site one night: rotates CDN image signatures (pure noise that must not register as change). */
  nextNight(): void {
    this.night++;
    this.requests.length = 0;
  }

  // ---- inventory helpers ------------------------------------------------------

  unit(stockNumber: string): MockUnit {
    const u = this.inventory.find((x) => x.stockNumber === stockNumber);
    if (!u) throw new Error(`mock unit ${stockNumber} not found`);
    return u;
  }

  update(stockNumber: string, patch: Partial<MockUnit>): MockUnit {
    return Object.assign(this.unit(stockNumber), patch);
  }

  remove(stockNumber: string): MockUnit {
    const u = this.unit(stockNumber);
    this.inventory = this.inventory.filter((x) => x !== u);
    return u;
  }

  /** New listings show at the top by default (newest first), shifting every later card down a slot. */
  add(unit: MockUnit, position: 'top' | 'bottom' = 'top'): void {
    this.inventory = position === 'top' ? [unit, ...this.inventory] : [...this.inventory, unit];
  }

  // ---- faults -----------------------------------------------------------------

  /** Fail requests whose path (+ query) matches. */
  fail(match: string | RegExp | ((path: string) => boolean), opts: FaultOptions = {}): void {
    const fn =
      typeof match === 'function' ? match : typeof match === 'string' ? (p: string) => p === match : (p: string) => match.test(p);
    this.faults.push({ match: fn, status: opts.status ?? 500, retryAfter: opts.retryAfter ?? '0', remaining: opts.times ?? Infinity });
  }

  failDetail(stockNumber: string, opts?: FaultOptions): void {
    this.fail(detailPath(this.unit(stockNumber)), opts);
  }

  /** `page` is 1-based, matching the site's `?page=N`. */
  failListPage(page: number, opts?: FaultOptions & { group?: MockUnit['group'] }): void {
    const base = opts?.group === 'trailers' ? '/trailers/type/all/store/' : '/trucks/type/all/store/';
    this.fail((p) => p === `${base}?page=${page}` || (page === 1 && p === base), opts);
  }

  clearFaults(): void {
    this.faults = [];
  }

  /** Requests served this night, filtered. */
  hits(match: RegExp): RequestLogEntry[] {
    return this.requests.filter((r) => match.test(r.path));
  }

  // ---- HTTP -------------------------------------------------------------------

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', this.url);
    const pathAndQuery = url.pathname + url.search;
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      this.requests.push({ path: pathAndQuery, status, userAgent: req.headers['user-agent'] });
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };

    const fault = this.faults.find((f) => f.remaining > 0 && f.match(pathAndQuery));
    if (fault) {
      fault.remaining--;
      return send(fault.status, `<h1>${fault.status}</h1>`, { 'retry-after': fault.retryAfter });
    }

    const group = LIST_PATHS[url.pathname];
    if (group) {
      const all = this.inventory.filter((u) => u.group === group);
      const pages = Math.max(1, Math.ceil(all.length / this.pageSize));
      let index = Math.max(0, Number(url.searchParams.get('page') ?? '1') - 1);
      if (index >= pages && this.outOfRangePage === 'first-page') index = 0;
      const slice = all.slice(index * this.pageSize, (index + 1) * this.pageSize);
      return send(200, renderListPage(this.url, slice, { index, pageSize: this.pageSize, total: all.length }, this.ctx()));
    }

    const unit = this.inventory.find((u) => detailPath(u) === url.pathname);
    if (unit) return send(200, renderDetailPage(this.url, unit, this.ctx()));

    send(404, '<h1>Not Found</h1>');
  }

  private ctx() {
    return { imageSignature: `sig${this.night}x${(this.night * 7919).toString(16)}`, layout: this.layout };
  }
}

export async function startMockDealer(opts?: MockDealerOptions): Promise<MockDealer> {
  return new MockDealer(opts).start();
}
