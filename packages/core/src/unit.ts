import { z } from 'zod';

/**
 * The canonical, source-agnostic shape of one inventory unit.
 * Every source config — whatever the site's platform — must normalize into this.
 */

export const MediaKind = z.enum(['image', 'video', 'document']);
export type MediaKind = z.infer<typeof MediaKind>;

export const MediaItem = z.object({
  kind: MediaKind,
  url: z.string().url(),
  /** Identity of the asset independent of signed/resized query params. */
  key: z.string(),
  position: z.number().int().nonnegative(),
});
export type MediaItem = z.infer<typeof MediaItem>;

export const Availability = z.enum(['available', 'pending', 'sold', 'on_order', 'unknown']);
export type Availability = z.infer<typeof Availability>;

export const Condition = z.enum(['new', 'used', 'unknown']);
export type Condition = z.infer<typeof Condition>;

export const Unit = z.object({
  sourceId: z.string(),
  dealerId: z.string(),
  /** Stable identity of the unit within its source (platform id > stock # > VIN, per config). */
  sourceUnitKey: z.string().min(1),
  listingUrl: z.string().url(),

  platformId: z.string().optional(),
  stockNumber: z.string().optional(),
  vin: z.string().optional(),
  serialNumber: z.string().optional(),

  title: z.string().optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  submodel: z.string().optional(),
  category: z.string().optional(),
  condition: Condition,
  mileage: z.number().nonnegative().optional(),
  hours: z.number().nonnegative().optional(),

  price: z.object({
    /** null = no public price (e.g. "Contact For Price"); see `text`. */
    amount: z.number().nonnegative().nullable(),
    msrp: z.number().nonnegative().nullable(),
    currency: z.literal('USD'),
    /** As displayed on the site. */
    text: z.string().optional(),
  }),
  availability: Availability,
  /** Raw availability text as shown on the site, kept for auditing the mapping. */
  availabilityRaw: z.string().optional(),
  isRental: z.boolean().optional(),
  location: z.string().optional(),
  description: z.string().optional(),

  /** Free-form label → value spec sheet, exactly as the dealer labels it. */
  specs: z.record(z.string(), z.string()),
  media: z.array(MediaItem),

  scrapedAt: z.string().datetime(),
  /** Non-fatal extraction issues (field conflicts between sources, unmapped values, …). */
  warnings: z.array(z.string()),
});
export type Unit = z.infer<typeof Unit>;
