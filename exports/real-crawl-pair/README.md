# Real change data: two live crawls, 4.5 hours apart

Both runs are real crawls of transwest.com, with nothing simulated:

| Run | Started (UTC) | Config | Units |
|---|---|---|---|
| `transwest-2026-11-10T23-47-02-882Z` | 2026-11-10 23:47 | v1 | 356 |
| `transwest-2026-11-11T04-20-54-254Z` | 2026-11-11 04:20 | v3 | 356 |

Imported in order (`pnpm db:import <runDir>`), then exported (`pnpm export --out exports/real-crawl-pair`).

## What changed on the dealer's site

| Event | Count | Notes |
|---|---|---|
| `NEW` | 2 | Listings added between the crawls |
| `PRICE_CHANGED` | 5 | 4 genuine repricings (e.g. CU17091 $23,474 → $24,069; G260496 and G260585 $73,603 → $72,603), plus I260002, whose card went from "Sold" to its $88,799 price |
| `AVAILABILITY_CHANGED` | 9 | I260002 **Sold → Available** (a sale falling through?), plus 8 rentals, explained below |
| missing | 2 | Gone from the site, still within the 2-run grace period, so not yet `REMOVED` |
| `DETAILS_CHANGED` / `MEDIA_CHANGED` | 0 | Nothing about these units' specs or photos changed |

**The 8 rental events are ours, not the dealer's.** Between the two crawls the Transwest config
went from v1 to v3, which maps "Rental" to `available`. The first crawl had these units as
`unknown`. A config change that alters normalization looks exactly like an inventory change. That
is a production concern (re-baseline or tag config-driven events on a version bump), and it's noted
in the write-up.

Photo URL signatures did **not** rotate between these crawls (all 5,501 shared photos had identical
URLs), so nightly re-signing is exercised by the mock dealer only.

Files have the same layout as the main export (see [../README.md](../README.md#files)).
