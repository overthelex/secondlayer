-- Polish inflection dictionary for search (PoliMorfologik 2.1, BSD), loaded by
-- scripts/pl/load_word_forms.py. The full-text indexes use the 'simple' configuration and
-- Postgres ships no Polish stemmer, so the search expands a query word into its inflected
-- forms instead of reindexing the texts.
--
-- pos keeps parts of speech apart under one lemma: 'zwolnienie' as a gerund of 'zwolnić'
-- must not pull in the verb's forms, and a negated form ('niezwolnienie') is its own group.
CREATE TABLE IF NOT EXISTS pl_word_forms (
  form  text NOT NULL,
  lemma text NOT NULL,
  pos   text NOT NULL,
  PRIMARY KEY (form, lemma, pos)
);
CREATE INDEX IF NOT EXISTS idx_pl_word_forms_lemma ON pl_word_forms (lemma, pos);
