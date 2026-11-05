import * as z from 'zod';
import { CountryCode, LISTING_BOUNDS } from './listing';

// `GET /locations` (Search_API): countries and cities that currently have public listings, with
// their listing counts. Used by the frontend for the country selector and the city autocomplete,
// so no choice ever leads to an empty result.

/** A country with at least one public listing. */
export const CountryFacet = z.object({
  /** ISO 3166-1 alpha-2, as stored in `address.country`. */
  code: CountryCode,
  count: z.int().min(1),
});

/** A city with at least one public listing; cities are distinct per country. */
export const CityFacet = z.object({
  /** One stored spelling of `address.city`; `city` matches it case-insensitively. */
  name: z.string().min(1).max(LISTING_BOUNDS.city.max),
  country: CountryCode,
  count: z.int().min(1),
});

export const LocationsDocument = z.object({
  /** Ordered by `code`. */
  countries: z.array(CountryFacet),
  /** Ordered by `country`, then `name` (code point order). */
  cities: z.array(CityFacet),
});

export type CountryFacet = z.infer<typeof CountryFacet>;
export type CityFacet = z.infer<typeof CityFacet>;
export type LocationsDocument = z.infer<typeof LocationsDocument>;
