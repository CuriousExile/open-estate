import {
  selectLocalizedVersion,
  serialize,
  type Listing,
  type LocalePreference,
  type LocalizedListing,
  type Taxonomy,
} from '@open-estate/shared';

/** Internal listing → API representation in the language version chosen for `prefs` (Req 14.3). */
export function localize(
  listing: Listing,
  prefs: readonly LocalePreference[],
  taxonomy: Taxonomy,
): LocalizedListing {
  return serialize(listing, { taxonomy, version: selectLocalizedVersion(listing, prefs) });
}
