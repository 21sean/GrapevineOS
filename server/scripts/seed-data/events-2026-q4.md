# Reviewed San Diego events, October to December 2026

Reviewed October 14, 2026. `events-2026-q4.json` adds 23 dated occurrences;
existing concerts, sports, festivals and recurring markets remain in the catalog.
Times use Pacific offsets, including the November 1 daylight saving transition.
Ratings on new rows are explicitly neutral editorial scores, not attendee ratings.

Organizer sources:

- [MCASD free admission](https://mcasd.org/events/ftt-11-19): third Thursdays, 11 AM to 7 PM. December 17 follows the published monthly policy.
- [Nat at Night](https://www.sdnhm.org/calendar/nat-at-night/): Fridays, 5 to 11 PM through December 18, excluding October 30 and December 4. Those exceptions are omitted.
- [Mission Trails](https://mtrp.org/marketplace/): November 14 and 15, 9 AM to 3 PM.
- [San Diego Made](https://www.sdmademarkets.com/holiday-2026-info): November 28, 10 AM to 5 PM; November 29, 10 AM to 4 PM.
- [Makers Arcade](https://www.makersarcade.com/holiday-fair-2026): December 12 and 13, 10 AM to 5 PM.
- [Female Maker Market](https://www.littleitalysd.com/events/the-female-maker-market): November 22 and December 20, 10 AM to 4 PM.
- [ArtReach](https://www.artreachsandiego.org/holiday-art-market/): December 5, 10 AM to 3 PM.
- [Little Italy tree lighting](https://www.littleitalysd.com/events/little-italy-tree-lighting): December 5, 4 to 8 PM.
- [SoNo Fest](https://sonofestchilicookoff.com/): December 6, 11 AM to 5 PM.
- [December Nights](https://www.sandiego.gov/december-nights): Friday, December 4, 4 to 10 PM (existing row corrected); Saturday, December 5, noon to 10 PM (new row).

From `server/`, preview or import the reviewed bundle:

```powershell
node --import tsx scripts/refresh-catalog.ts scripts/seed-data/events-2026-q4.json
node --import tsx scripts/refresh-catalog.ts scripts/seed-data/events-2026-q4.json --apply
```

Apply makes a raw event backup under ignored `server/data/catalog-backups/`
before writing. It uses the catalog's natural dedupe keys and skips events
that have already ended. `corrections-2026-q4.sql` records the reviewed
schedule repairs applied to existing rows; it is not a schema migration.
Expired rows were removed only when no calendar save or reaction referenced
them. The browser API excludes all ended rows, including retained history.
