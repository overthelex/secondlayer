-- 189_edrnpa_number_norm_index.sql
--
-- search_edrnpa compared c.number by raw equality against a column holding
-- 5 435 NULLs, 97 zero-padded numbers ("007"), 11 929 containing Roman
-- characters, and shapes like 08-а, 02/01, 1-зп, 10-VII, 1/2023-рп. So a user
-- typing «7» never found «007», and a Roman numeral typed in Cyrillic never
-- matched the same numeral stored in Latin.
--
-- opendata-tools.ts now compares npa.norm_number(c.number) = npa.norm_number($n).
-- This index is what keeps that an index scan rather than a sequential one over
-- 140 930 cards.
--
-- Held back from migration 187 on purpose: at that point nothing normalised the
-- query side, so the index would have carried maintenance cost while
-- accelerating nothing. It ships with the query change, not before it.
--
-- npa.norm_number is IMMUTABLE precisely so this is possible.

CREATE INDEX IF NOT EXISTS idx_edrnpa_number_norm
  ON public.opendata_edrnpa_cards (npa.norm_number(number))
  WHERE number IS NOT NULL;
