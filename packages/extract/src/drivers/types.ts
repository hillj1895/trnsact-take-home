import type { FieldName, Logger, MediaItem, SourceConfig } from '@trnsact/core';
import type { HttpClient } from '@trnsact/http';
import type { Scalar } from '../transforms.js';

export type RawFields = Partial<Record<FieldName, Scalar>>;

/** A unit as seen on a list/search page — enough to identify it and decide whether to fetch detail. */
export interface ListingStub {
  key: string;
  url: string;
  fields: RawFields;
  warnings: string[];
  /** Page the stub was discovered on (for debugging/coverage). */
  foundOn: string;
}

export interface ListPageResult {
  pageUrl: string;
  stubs: ListingStub[];
  /** Result count the site claims, if the config knows where to find it. */
  siteTotal?: number;
  nextUrl?: string;
}

export interface DetailResult {
  url: string;
  fields: RawFields;
  specs: Record<string, string>;
  media: MediaItem[];
  warnings: string[];
}

export interface DriverContext {
  config: SourceConfig;
  http: HttpClient;
  logger: Logger;
}

export interface DiscoverOptions {
  /** Cap pages per start URL (for quick runs). */
  maxPages?: number;
}

/**
 * A Driver is the *code* half of the system: it knows how to talk to one kind
 * of site (server-rendered HTML, a JSON search API, a headless-only SPA, …).
 * The SourceConfig is the *data* half: where things are on one dealer's site.
 */
export interface Driver {
  readonly name: string;
  discover(ctx: DriverContext, opts?: DiscoverOptions): AsyncIterable<ListPageResult>;
  fetchDetail(ctx: DriverContext, stub: ListingStub): Promise<DetailResult>;
}
