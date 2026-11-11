import { z } from 'zod';
import { Availability, Condition, MediaKind } from './unit.js';

/**
 * A SourceConfig is *data*, not code. Adding a dealer on an already-supported
 * driver means adding one of these (to a file, S3 or a DB row) — no deployment.
 * Only a genuinely new kind of site (a new driver) requires shipping code.
 */

/** Canonical field names an extractor may populate. Typos in configs fail validation. */
export const FIELD_NAMES = [
  'platformId',
  'stockNumber',
  'vin',
  'serialNumber',
  'title',
  'year',
  'make',
  'model',
  'submodel',
  'category',
  'condition',
  'mileage',
  'hours',
  'price',
  /** Price as displayed ("$79,900", "Contact For Price") — keeps hidden-price signal. */
  'priceText',
  'msrp',
  'availability',
  'isRental',
  'isSold',
  'location',
  'description',
  'listingUrl',
] as const;
export const FieldName = z.enum(FIELD_NAMES);
export type FieldName = z.infer<typeof FieldName>;

export const TRANSFORMS = [
  'trim', // trim + collapse internal whitespace
  'number', // "162,371 mi" -> 162371
  'int',
  'price', // "$79,900" -> 79900, "Call for price" -> null
  'absUrl', // resolve against the page URL
  'stripQuery',
  'lower',
  'upper',
  'bool', // "true"/"yes"/"1" -> true
  'nullIfEmpty',
] as const;
export const TransformName = z.enum(TRANSFORMS);
export type TransformName = z.infer<typeof TransformName>;

/** Post-processing shared by every extractor kind. Applied in order: regex → transforms → map. */
const Post = z.object({
  /** First capture group (or whole match) of this regex. */
  regex: z.string().optional(),
  transforms: z.array(TransformName).default([]),
  /** Case-insensitive value mapping applied last, e.g. {"available for lease": "available"}. */
  map: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** Read from the DOM (relative to the current scope: a list card, or the whole detail page). */
const DomExtractor = Post.extend({
  from: z.literal('dom').optional(),
  /** CSS selector; omit to read the scope element itself. */
  selector: z.string().optional(),
  /** Attribute to read; omit for text content. */
  attr: z.string().optional(),
  /** Dot path into the value parsed as JSON, e.g. "vin" or "items[0].price". */
  json: z.string().optional(),
});

/** Read from the page's schema.org JSON-LD node (type chosen by detail.jsonLd.type). */
const JsonLdExtractor = Post.extend({
  from: z.literal('jsonld'),
  /** Dot path; "[]" flattens arrays, e.g. "image[].url". */
  path: z.string(),
});

/** Read from the parsed spec sheet by its label (case-insensitive; first matching label wins). */
const SpecExtractor = Post.extend({
  from: z.literal('spec'),
  label: z.union([z.string(), z.array(z.string()).min(1)]),
});

const ConstExtractor = z.object({
  from: z.literal('const'),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const Extractor = z.union([JsonLdExtractor, SpecExtractor, ConstExtractor, DomExtractor]);
export type Extractor = z.infer<typeof Extractor>;

/** One extractor, or an ordered fallback chain (first non-empty wins; disagreements are recorded). */
export const FieldRule = z.union([Extractor, z.array(Extractor).min(1)]);
export type FieldRule = z.infer<typeof FieldRule>;

const FieldMap = z.record(FieldName, FieldRule);

export const SpecBlock = z.object({
  /** Selector for each label/value row. */
  row: z.string(),
  /** Selector (within row) for the label. */
  label: z.string(),
  /** Selector (within row) for the value; omit to use the row's text minus the label. */
  value: z.string().optional(),
});
export type SpecBlock = z.infer<typeof SpecBlock>;

export const MediaRule = z.object({
  kind: MediaKind,
  extract: Extractor,
  /** Only keep URLs matching this regex. */
  include: z.string().optional(),
  /** Drop URLs matching this regex (e.g. site-wide embeds, logos). */
  exclude: z.string().optional(),
});
export type MediaRule = z.infer<typeof MediaRule>;

export const Pagination = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('queryParam'),
    param: z.string(),
    start: z.number().int().default(1),
    step: z.number().int().positive().default(1),
    maxPages: z.number().int().positive().default(200),
  }),
  z.object({
    type: z.literal('nextLink'),
    selector: z.string(),
    maxPages: z.number().int().positive().default(200),
  }),
]);
export type Pagination = z.infer<typeof Pagination>;

export const SourceConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Bumped on every config change; recorded with each run so output is traceable to a config. */
  version: z.number().int().positive(),
  enabled: z.boolean().default(true),
  dealer: z.object({ id: z.string(), name: z.string() }),
  /** Which code driver interprets this config, e.g. "html". */
  driver: z.string(),
  baseUrl: z.string().url(),
  notes: z.string().optional(),

  http: z
    .object({
      requestsPerSecond: z.number().positive().max(10).default(1),
      concurrency: z.number().int().positive().max(8).default(2),
      timeoutMs: z.number().int().positive().default(20_000),
      retries: z.number().int().nonnegative().max(6).default(3),
      /** Override the default (self-identifying) bot UA — only where a site's WAF blocks it. */
      userAgent: z.string().optional(),
      headers: z.record(z.string(), z.string()).default({}),
    })
    .default({}),

  list: z.object({
    startUrls: z.array(z.string()).min(1),
    pagination: Pagination,
    /** Selector for one unit card. Card fields are extracted relative to it. */
    item: z.string(),
    /** Extracted from the whole page; the site's claimed result count, used for coverage checks. */
    total: Extractor.optional(),
    fields: FieldMap,
  }),

  detail: z
    .object({
      enabled: z.boolean().default(true),
      jsonLd: z.object({ type: z.string() }).optional(),
      specs: z.array(SpecBlock).default([]),
      /**
       * Spec labels that duplicate a tracked facet (e.g. "List Price", "Status") and so are
       * left out of the details hash — otherwise one price cut fires PRICE_ and DETAILS_CHANGED.
       */
      hashIgnoreSpecs: z.array(z.string()).default([]),
      /** Detail fields override list fields when both are present (conflicts become warnings). */
      fields: FieldMap.default({}),
      media: z.array(MediaRule).default([]),
    })
    .optional(),

  /** Fields tried in order to form sourceUnitKey. */
  identity: z.array(FieldName).min(1),

  normalize: z
    .object({
      availability: z.record(z.string(), Availability).default({}),
      condition: z.record(z.string(), Condition).default({}),
    })
    .default({}),
});
export type SourceConfig = z.infer<typeof SourceConfig>;
export type SourceConfigInput = z.input<typeof SourceConfig>;
