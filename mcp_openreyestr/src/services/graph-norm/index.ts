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
export { buildStreetRenamingIndex, StreetRenamingIndex, StreetRenamingsCache, STREET_RENAMINGS_SQL } from './street-renamings';
export type { StreetRenamingRow, BuildRenamingOptions, RenamingIndexStats, Queryable } from './street-renamings';
// person names: the ЄДР history module already normalises them
export { normUa, uaMatchKey, historyNameKey, countryIso } from '../edr-history/norm';
