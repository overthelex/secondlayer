/**
 * Notices every Find Case Law response carries (TNA licence CAS-349914-B9P5B8),
 * kept in one place so uk_search_judgments and search_registry cannot drift.
 * The coverage figures are measured facts; when the holding changes, change them here.
 */

export const JUDGMENT_ATTRIBUTION =
  'Contains information licensed under the Open Justice - Licence v2.0. Source: Find Case Law, The National Archives.';

/** Principle 3: users told where the holding is incomplete, at the point of search. */
export const JUDGMENT_COVERAGE =
  'The corpus is incomplete: 54,453 judgments of about 95,800 on Find Case Law, loaded up to May 2026. ' +
  'The Court of Appeal (Criminal Division) and the King’s Bench Division are missing; the Administrative Court stops in April 2016; ' +
  'Scotland and Northern Ireland are not covered. No result does NOT mean no such judgment exists.';

/** Principle 8: output labelled as machine-generated, with how and where to verify. */
export const JUDGMENT_MACHINE_GENERATED =
  'Machine-generated search result. LawRider selected these judgments and extracts automatically, ' +
  'by full-text search; no language model wrote, summarised or interpreted them. Check every passage ' +
  'against the authoritative record at source_url before relying on it.';

/** The three together, for spreading into any response. */
export const JUDGMENT_NOTICES = {
  machine_generated: JUDGMENT_MACHINE_GENERATED,
  coverage: JUDGMENT_COVERAGE,
  licence: JUDGMENT_ATTRIBUTION,
};
