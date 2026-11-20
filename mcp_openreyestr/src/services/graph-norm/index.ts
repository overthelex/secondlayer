/** Normalisation for the company / person / address relationship graph (LEXAI-2302). */
export { normEdrpou, isValidEdrpou, edrpouCheckDigit } from './edrpou';
export type { EdrpouNorm, EdrpouProblem } from './edrpou';
export {
  normAddress, parseAddressParts, parseStreetName, streetCoreKey, settlementKeyOf, normBuilding,
  formatAddress, oblastFromPostcode, prepText, foldWord, STREET_SHORT,
} from './address';
export type {
  AddressParts, AddressKeys, NormalisedAddress, NormAddressOptions, ParseStatus, PremisesType,
  SettlementType, StreetRef, StreetRenamingLookup, StreetType,
} from './address';
export {
  buildStreetRenamingIndex, StreetRenamingIndex, StreetRenamingsCache, STREET_RENAMINGS_SQL, STREET_RENAMINGS_SCOPED_SQL, scopedRowsOf,
  renamingSettlementKey,
} from './street-renamings';
export type { StreetRenamingRow, BuildRenamingOptions, RenamingIndexStats, Queryable, StreetRenamingsCacheOptions } from './street-renamings';
export { candidatePairs, RenamingAggregator, streetKeyOf } from './street-renaming-derive';
export type { AddressObservation, RenamingCandidate, FilterOptions, FilterStats, ScopedRenaming } from './street-renaming-derive';
export {
  OsmSettlementIndex, OsmRenamingAggregator, osmPairs, readStreetName, settlementKind, dominantPostcode, FORMER_NAME_KEY,
} from './osm-street-renamings';
export type { OsmArea, OsmPlace, OsmStreet, OsmSettlement, OsmRenamingRow, OsmAggregateStats, OsmPair } from './osm-street-renamings';
// person names: the ЄДР history module already normalises them
export { normUa, uaMatchKey, historyNameKey, countryIso } from '../edr-history/norm';
export { stripPersonIds, stripIdNumbers, hasTenDigits, NAME_ID_PROBE_SQL, TEXT_ID_PROBE_SQL, TEN_DIGITS_SQL } from './personal-ids';
