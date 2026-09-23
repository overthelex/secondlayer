# Метoдика audit: the datasets

Everything the audit claims about the AMCU **Методика визначення монопольного
(домінуючого) становища суб'єктів господарювання на ринку** can be recomputed
from the four files here. They are the outputs of
[`scripts/metodyka/`](../../scripts/metodyka); nothing in them was edited by
hand.

## The instrument

| | |
|---|---|
| act | розпорядження АМКУ N 49-р, 5 March 2002 |
| registered | Ministry of Justice, 1 April 2002, N 317/6605 |
| identifier | [`z0317-02`](https://zakon.rada.gov.ua/laws/show/z0317-02) |
| editions | one, for the whole of its life |
| repealed | 1 August 2026, by [`z1043-26`](https://zakon.rada.gov.ua/laws/show/z1043-26) (розпорядження N 2-рп, 11 June 2026) |

The single edition is not an assumption: the register's own card
([card/z0317-02](https://zakon.rada.gov.ua/laws/card/z0317-02)) lists
"Редакції документа (2 редакції)" and the second of them is the repeal.

## The files

### `propositions.json` (66 records)

The instrument cut into its numbered items, from the text of the edition of
5 March 2002. The unit is the numbered item because that is the unit the
record cites: decisions say "пунктом 6.1 Методики".

Fields: `number`, `rozdil`, `rozdil_title`, `depth`, `text`.

### `goldset.jsonl` (2,315 records)

Every document found to cite the Методика, with the pinpoints it cites and the
sentence around each. One record per document.

Fields: `corpus` (`amcu` or `court`), `doc_id`, `mentions`, and `cites`, a
list of `{kind, number, context}` where `kind` is `punkt` or `rozdil`.

A mention counts as this instrument only when its title follows it, or when
the document establishes the title and carries no competing one. That test
matters: the court register is full of методики for computing tariffs,
damages and unmetered electricity, and a search for the word alone returns
them all.

### `coverage.json`

The two crossed: for each proposition, how many agency and court documents
cite it by number, and which. Also the розділ-level references, and the
numbers cited that the instrument does not have.

### `corpus-manifest.csv` (8,980 rows)

Which documents the corpus held. One row per document, with the identifier it
carries in its source register, its length, the SHA of its normalised text,
whether it was the copy kept when a decision is published twice, and how many
passages it contributed.

This is what makes the corpus reproducible without shipping it: 121 MB of
decision text, 191,593 passages and 400 MB of vectors do not belong in git,
but a rebuild can be checked document by document against the hashes here
rather than by a row count.

### `checksums.txt`

SHA-256 and byte length of each file above.

## Where the material comes from

Both corpora are read from their issuing bodies, not from an intermediary.

**Agency decisions** come from the AMCU's own open data publication on
data.gov.ua, dataset "Рішення та рекомендації Антимонопольного комітету
України", package `8bdd45b8-0684-463a-ba76-26361c32841a`. Each archive is
named after the CKAN resource that holds it, so `008a2ce8_rish_gruden_2025.zip`
is resource `008a2ce8-ff41-…`, and every decision traces back to the published
file it came out of. The portal's coverage begins in 2017.

**Court decisions** come from the Єдиний державний реєстр судових рішень.

**The instrument** comes from the Verkhovna Rada's legislation register.

## Rebuilding

    python3 scripts/amcu/04_backfill_doc_texts.py refresh
    python3 scripts/amcu/04_backfill_doc_texts.py run
    python3 scripts/amcu/04_backfill_doc_texts.py singles

    python3 scripts/metodyka/metodyka.py parse --source db
    python3 scripts/metodyka/goldset.py build --out goldset.jsonl
    python3 scripts/metodyka/coverage.py --goldset goldset.jsonl --json coverage.json
    python3 scripts/metodyka/retrieve.py build
    python3 scripts/metodyka/retrieve.py passages
    python3 scripts/metodyka/datasets.py --out data/metodyka

## Known limits of the material

- The agency corpus starts in 2017, because that is when the portal starts.
  The instrument dates from 2002, so the long half of the record is the court
  side.
- 2,498 agency decisions carry redaction markers ("Інформація, доступ до якої
  обмежено"); in 1,093 of them the markers are more than a tenth of the
  characters, and in 52 more than a quarter. What is removed is names and
  figures, and the reasoning survives, but a claim about a number in a
  particular decision cannot be checked against these texts.
- The court side of the corpus is restricted to decisions that name the
  Методика. It cannot find a proposition applied in a case that never names
  the instrument.
