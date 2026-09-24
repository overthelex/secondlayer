# Auditing a guidance instrument against the record that applies it: the AMCU Методика, 2002-2026

Design note and running record of what has been measured. Companion to the
Swiss study of WEKO's Vertikalbekanntmachung; same method, different legal
order, and an object that removes several of the Swiss study's difficulties.

## The object

The **Методика визначення монопольного (домінуючого) становища суб'єктів
господарювання на ринку**, approved by розпорядження of the Antimonopoly
Committee of Ukraine N 49-р of 5 March 2002 and registered with the Ministry
of Justice on 1 April 2002 under N 317/6605
([`z0317-02`](https://zakon.rada.gov.ua/laws/show/z0317-02)).

Two properties make it a better object than the Swiss notice.

**It was never amended.** The register's card
([card/z0317-02](https://zakon.rada.gov.ua/laws/card/z0317-02)) lists two
entries under "Редакції документа", and the second is the repeal. One text
governed for twenty four years, so there is no alignment across versions to
get wrong, and no question of which version a decision of a given year was
applying.

**It has just been replaced.** It lost force on 1 August 2026, superseded by
the Методика визначення товарного ринку та монопольного (домінуючого)
становища approved by розпорядження N 2-рп of 11 June 2026
([`z1043-26`](https://zakon.rada.gov.ua/laws/show/z1043-26)). The audit
therefore lands at the changeover, and what the record shows about the old
instrument can be read against what the new one changed.

## The question

Schrepel and Jenny's computational audit asks of a guidance instrument
whether the agency's own decisional record bears out what the instrument
announces, and separates what the instrument **codifies** (restating law that
binds anyway) from what it **announces** (a policy the agency adopts on its
own authority). Codification adds nothing to the law and shows up in the
record as a provision nobody needs to cite; announcement is where the
instrument does work.

Put to the Методика, the question splits in two:

1. Which of its propositions does the record use, and which does nobody use?
2. Where agency and courts diverge in what they use, what explains the
   divergence?

## The unit

One proposition is one numbered item. That is not a design choice: it is the
unit the record cites at. Decisions say "пунктом 6.1 Методики", never "the
second sentence of 6.1".

The instrument has 66 such items across 11 розділи, 34,350 characters of
operative text. See
[`scripts/metodyka/metodyka.py`](../../../scripts/metodyka/metodyka.py) and
[`data/metodyka/propositions.json`](../../../data/metodyka/propositions.json).

## The record

| corpus | documents | source |
|---|---|---|
| AMCU decisions | 6,820 with text | the agency's own open data publication, data.gov.ua package `8bdd45b8-0684-463a-ba76-26361c32841a` |
| court decisions citing the Методика | 2,160 | Єдиний державний реєстр судових рішень |

Both are read from the issuing bodies, not from an intermediary corpus.

The agency side had to be recovered before it could be used. Of 6,846 rows,
only 2,604 carried text, and the split was exact: every `.docx` had been
extracted and every `.doc` had not, so any question put to the table was
answered from 38% of the corpus, silently. The archives were no longer on
disk, but the provenance was recoverable from the archive names, each of
which encodes the CKAN resource that published it, so every decision traces
back to the exact published file. 4,220 of the 4,225 missing rows now carry
text, and in 97.4% of all extracted rows the decision's own number appears
inside the text it was matched to. See
[`scripts/amcu/04_backfill_doc_texts.py`](../../../scripts/amcu/04_backfill_doc_texts.py).

## Finding the citations

"Методика" is a generic word. The court register is full of методики for
computing tariffs, damages and unmetered electricity, and a search for the
word returns them all. A mention counts as this instrument only when its
title follows it, or when the document establishes the title and carries no
competing one; a pinpoint binds only to the reference immediately beside the
mention, because a first pass attached a statute's "п. 23" to the Методика on
the strength of sharing a sentence with it.

Three traps in the data, each worth naming because each changed a number:

- "пункту 3 розділу 1" is item **1.3**, not 3;
- "п. 1.З." is a Cyrillic З typed for a 3;
- the register wraps lines inside a number, and "10.1\n.5" read as an item
  the instrument does not have.

See [`scripts/metodyka/goldset.py`](../../../scripts/metodyka/goldset.py) and
[`data/metodyka/goldset.jsonl`](../../../data/metodyka/goldset.jsonl).

## What the citations show

2,315 documents cite the Методика: 167 agency decisions and 2,148 court
decisions. 62 of the 66 propositions are cited by number at least once.

Never cited by anyone, in twenty four years: **10.1.6.1**, **10.1.6.3**,
**10.2.4** and the one-word item **4.2.4**. The first three are the whole
machinery of collective dominance.

The agency and the courts use different halves of the instrument. The agency
cites the market-definition розділи (6.1 fifty five times, 5.1 fifty two,
3.1 forty five) and hardly touches розділ 10, the dominance test itself:
пункт 10.2 never, and 10.2.1, which states the 35% threshold, never.

That asymmetry survives the obvious objection. 37% of the agency's published
texts carry redaction markers, so it might be an artefact of what is
published. It is not: of the 62 agency decisions that discuss the 35%
threshold and mention the Методика, 52 cite **статтю 12 of the Law** and only
3 cite пункт 10.2. Розділ 10 restates the statute, so the agency goes to the
statute. What the Методика contributes on its own authority is market
definition, and that is exactly where the agency uses it.

This is the codification/announcement line, measured rather than assumed.

See [`scripts/metodyka/coverage.py`](../../../scripts/metodyka/coverage.py)
and [`data/metodyka/coverage.json`](../../../data/metodyka/coverage.json).

## Why citations are not enough

A proposition nobody cites by number is not thereby a dead letter: the rule
may be applied in substance, in a decision's own words. Calling a proposition
unsupported requires a search of the whole record that comes back empty.

The corpus is cut into 191,593 passages of 1,200 characters, embedded with
bge-m3 (CLS pooling) on a single L4 in 26 minutes, and searched by cosine over
the whole corpus rather than as a re-rank of a keyword pool. Proposition
recall on the 3,673 citation pairs:

| retrieval | k=50 | k=100 | k=200 |
|---|---|---|---|
| keyword over passages | | 0.710 | |
| dense | 0.790 | 0.839 | |
| the two together | 0.839 | 0.871 | 0.887 |

The two miss different propositions, which is why the pool the judge sees is
the union of both.

One idea was tried and dropped. Five of the 66 items are a single short
phrase ("Визначення товарних меж ринку."), and prefixing such a query with
its розділ heading looked like the obvious repair. It made things worse:
dense recall at k=100 fell from 0.839 to 0.790. The heading is the
instrument's own boilerplate, and it pulls the query towards every passage
that quotes the Методика instead of towards the decisions that apply the
item.

The gate is better stated by what it leaves out than by its number. At k=200
the eight propositions retrieval cannot reach are cited 20 times in total out
of 3,699 citations, half a percent of the record, and every one of those
citations is a court's rather than the agency's. They are the
thinnest-evidenced items in the instrument: five of them are cited once or
twice in twenty four years.

See [`scripts/metodyka/retrieve.py`](../../../scripts/metodyka/retrieve.py),
[`run_gpu.sh`](../../../scripts/metodyka/run_gpu.sh) and
[`packet.py`](../../../scripts/metodyka/packet.py), which assembles the 66
propositions with the eight passages each that the reader and the judge both
see. Two of the eight places are reserved for what only the keyword search
found, because at that size the dense ranking fills the pool on its own and
the propositions dense cannot reach would see nothing.

*Pending: the reading of the packet, the judge run against it, and the
comparison with what `z1043-26` changed.*

## What the corpus had to be cleaned of

The embedding was first started before the corpus had been looked at. That
was the wrong order. The look afterwards, counted over 8,980 documents rather
than guessed at, found non-breaking spaces in 5,821 of them, a byte order
mark in 4,221, runs of blank lines in 2,788, form rules in 468, and a
scattering of soft hyphens, zero-width spaces, dot leaders and words wrapped
with a hyphen. The non-breaking space mattered most: the tokeniser does not
join across it.

Two findings were substantive rather than cosmetic. 643 decisions are
published twice, the monthly archive and the "зі змінами" archive carrying
the same text under different names; left in, one decision would have
registered as several supports. And bid-rigging decisions carry appendices of
IP addresses, timestamps, correlation columns and the PDF metadata of every
tender file, which came back as candidates for propositions they say nothing
about; below 45% Cyrillic letters the passages are numeric columns and file
listings, above it they are prose, and the cut was put where the two stop
overlapping after reading samples on both sides.

Passages: 205,735 before, 191,593 after. The run was restarted on clean text.

## Reproducibility

Code, by stage:

| stage | file |
|---|---|
| recover the agency texts | [`scripts/amcu/04_backfill_doc_texts.py`](../../../scripts/amcu/04_backfill_doc_texts.py) |
| cut the instrument | [`scripts/metodyka/metodyka.py`](../../../scripts/metodyka/metodyka.py) |
| find the citations | [`scripts/metodyka/goldset.py`](../../../scripts/metodyka/goldset.py) |
| cross the two | [`scripts/metodyka/coverage.py`](../../../scripts/metodyka/coverage.py) |
| corpus, passages, search | [`scripts/metodyka/retrieve.py`](../../../scripts/metodyka/retrieve.py) |
| embedding on a GPU | [`scripts/metodyka/gpu_io.py`](../../../scripts/metodyka/gpu_io.py), [`gpu_startup.sh`](../../../scripts/metodyka/gpu_startup.sh), [`run_gpu.sh`](../../../scripts/metodyka/run_gpu.sh) |
| the review packet | [`scripts/metodyka/packet.py`](../../../scripts/metodyka/packet.py) |
| export the datasets | [`scripts/metodyka/datasets.py`](../../../scripts/metodyka/datasets.py) |

Data: [`data/metodyka/`](../../../data/metodyka), with a
[README](../../../data/metodyka/README.md) recording provenance down to the
CKAN package and the resource id encoded in each archive name, and
`checksums.txt` for each file. The corpus itself is not in the repository;
`corpus-manifest.csv` names all 8,980 documents by their identifiers in the
source registers with the hash of each normalised text, so a rebuild is
checked document by document.

Pull requests: [#2459](https://github.com/overthelex/secondlayer/pull/2459)
recovers the agency texts, [#2460](https://github.com/overthelex/secondlayer/pull/2460)
adds the audit tooling, [#2461](https://github.com/overthelex/secondlayer/pull/2461)
adds retrieval, [#2462](https://github.com/overthelex/secondlayer/pull/2462)
cleans the corpus, [#2463](https://github.com/overthelex/secondlayer/pull/2463)
publishes the datasets.

## Limits

- The agency corpus begins in 2017, because that is when the portal begins.
  The instrument dates from 2002, so the long half of the record is the court
  side, and any statement about agency practice before 2017 is out of reach.
- 2,498 agency decisions carry redaction markers; in 1,093 they are more than
  a tenth of the characters and in 52 more than a quarter. Names and figures
  are what is removed and the reasoning survives, but a claim about a
  particular figure in a particular decision cannot be checked here.
- The court side is restricted to decisions that name the Методика, so a
  proposition applied in a case that never names the instrument is invisible
  to this design. The restriction is deliberate: it keeps the measurement
  from drowning in competition cases decided on the statute alone.
- Retrieval is bge-m3 over passages, so a proposition stated in the record in
  wholly different vocabulary can still be missed. The gate measurement on
  the citation pairs is what bounds that, and it is reported rather than
  assumed.
