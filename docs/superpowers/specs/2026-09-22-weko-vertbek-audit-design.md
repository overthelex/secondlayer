# A computational audit of WEKO's vertical-restraints notice

Design for a paper, target venue *Stanford Computational Antitrust*.
Model: Schrepel & Jenny, "Lessons from a Computational Audit of the European
Commission's Draft Merger Guidelines" (SSRN 7372939), which tests a guidance
document against the agency's own decisional record and asks whether its
provisions codify practice or announce policy in the voice of practice.

Status: design approved in chat on 2026-09-22. Implementation plan follows.

## 1. The question

The Wettbewerbskommission (WEKO) states how it will treat vertical agreements
in a *Bekanntmachung* (VertBek) and an accompanying *Erläuterungen*. Neither
binds a court; both steer the market and are cited in proceedings. The
Erläuterungen say in their own text that they take the wording of the EU
vertical guidelines over where they refer to them.

A Swiss notice therefore has three possible sources for any proposition it
states: WEKO's own decisional record, the Kartellgesetz, or EU text. The paper
measures which one each proposition actually has.

**Research question.** For every proposition in the vertical-restraints notice
and its explanatory memorandum, in every version from 2002 to 2022: is it
supported by the Swiss record at the time it was written, was it announced
ahead of that record, or is it wording imported from the EU?

**Why it matters.** An agency that announces policy in the voice of settled
practice takes a legitimacy shortcut (Schrepel & Jenny's finding for the
Commission). A small jurisdiction has a second shortcut available: importing
another regulator's text. The first is contested; the second is rarely
measured at all.

**A negative result is publishable.** If the propositions turn out to be
grounded in the Swiss record, the contribution is the transposed, repeatable
method plus the finding that Swiss soft law passes a test the Commission's
draft did not.

## 2. Scope

**In scope.** Bekanntmachung über die wettbewerbsrechtliche Behandlung
vertikaler Abreden and its Erläuterungen, every version (2002, 2007, 2010,
Stand 2017, 2022), German text as the reference, French and Italian consulted
where the German is ambiguous.

**The record tested against.** WEKO decisions (`CH_WEKO_RPW` + `CH_WEKO`),
Bundesverwaltungsgericht and Bundesgericht/BGE judgments in competition
matters. This mirrors Schrepel & Jenny's pairing of Commission decisions with
Union Court judgments.

**Cantonal law is not part of the object, cantonal judgments are part of the
record.** Measured on 2026-09-22, not assumed: of 26,296 cantonal acts in
`ch_cantonal_registry`, exactly two carry "Kartell" in their title, and both
are implementing ordinances to the FEDERAL cartel act of 1962 (BS, GR). There
is no substantive cantonal competition legislation — the competence is
federal (Art. 96 BV), so no proposition of the notice can rest on cantonal
law. Civil enforcement of Art. 5 KG, however, runs through the cantonal
courts, and our corpus holds 130+ of their judgments citing the
Kartellgesetz (ZH 48, VD 29, SG 17, BE 11, LU 8, BS 6, GR 6, AG 5); RPW
reprints a selection in its part C. For a vertical-restraints instrument
that is real practice, so they enter the record as a **second, labelled
evidence tier** (see 4.3). Schrepel & Jenny have no equivalent tier: the EU
has no comparable civil layer applying the same provision.

**Out of scope for v1.** The SME notice (KMU-Bekanntmachung) and the motor
vehicle notice; merger control. Each is a follow-up that the same pipeline
can run.

## 3. Data

### 3.1 What exists

| Source | State | Notes |
|---|---|---|
| WEKO decisions 1995–2025 | **1,537 loaded** (`spider = CH_WEKO_RPW`) | cut from the RPW journal, PR #2451/#2452 |
| WEKO files from entscheidsuche | 117 (`spider = CH_WEKO`) | 62 RPW documents point at one via `metadata_json.rpw.same_as` |
| BVGer / BGer / BGE | in `ch_court_decisions` | competition matters selected by statute references and full text; 51 of them name the vertical notice or vertical agreements outright |
| Cantonal civil judgments citing the KG | 130+ in `ch_court_decisions` | second evidence tier; ZH 48, VD 29, SG 17, BE 11, LU 8, BS 6, GR 6, AG 5 |
| Swiss scholarly commentary | 1,564 rows (`ch_commentary`) | used to build the retrieval-recall check, not as evidence |
| Kartellgesetz, point in time | 10 of Fedlex's 12 German editions, 2001-01-01 … 2023-07-01 (`ch_act` 9447) | holds both decisive states (before the revision, and from 2004-04-01: direct sanctions, Art. 5 para. 4) and the edition the 2002 instrument was written under; the two 1996 editions carry no text at Fedlex at all, see 3.3 |

### 3.2 What has to be acquired

1. **Every version of the notice and the Erläuterungen.**
   - Current and some superseded versions: PDFs on weko.admin.ch.
   - Versions as published, with their entry-into-force dates: RPW part D1.
     The RPW cut does not produce them yet — D1 items are numbered at chapter
     level (`D1   1.   Bekanntmachung über ...`) while `chpipe/rpw.py` requires
     a section number (`B 2.3   1.`). Extending the cut to chapter-level items
     is the first implementation task.
2. **EU comparison texts.** Vertical Guidelines 2010 and 2022, Regulation
   330/2010 and Regulation 2022/720. Check the existing EUR-Lex slice first;
   fetch what is missing.

### 3.3 The statute, version by version

The audit runs against a statute that changed under it, so every proposition
carries the KG version in force on the date of the instrument version that
introduced it.

- **The 2003 revision (in force 1 April 2004) is the dividing line.** It
  introduced direct sanctions and Art. 5 para. 4 — the presumption for resale
  price maintenance and absolute territorial protection, which is exactly what
  a vertical-restraints notice is about. **A decision issued before 1 April
  2004 cannot support a proposition that rests on Art. 5 para. 4**: the
  provision did not exist. The label for such a pairing is *absent*, and the
  proposition is measured against the record that came after it.
- **The 1996 editions have no text anywhere, and the audit does not need
  them.** Checked twice on 2026-09-23: the Fedlex SPARQL endpoint lists 12
  editions of the KG, but the two 1996 ones (1996-02-01, 1996-06-17) and the
  1996-07-01 edition of the merger ordinance carry no manifestation at all —
  no XML, no PDF, no file. A second public Swiss corpus returns the same:
  "Fedlex has an edition of SR 251 dated 1996-06-17 ... but no
  machine-readable text (formats present: none)". Our own tables hold nothing
  earlier either, and our Bundesblatt slice starts after 1997. So this is not
  a harvest gap to close; it is a limit of the source.
  It does not block the audit: the 1996-06-17 edition ran to 2000-12-31 and
  the 2001-01-01 edition to 2004-03-31, so **the 2002 instrument was written
  under the 2001-01-01 edition, which we hold in full**. Only decisions from
  1997-2000 sit under a statute we cannot quote; the paper says so and uses
  the 2001 edition as the nearest reference for that window.
- **Query by `act_id`, never by `sr_number`.** `sr_number = '251'` also
  matches a cantonal code of criminal procedure in the same table; the KG is
  `act_id = 9447`. The sanctions ordinance (SVKG, SR 251.5, 3 versions) and
  the merger-control ordinance (SR 251.4, 2 versions) are separate acts.

### 3.4 Corpus completeness, stated in the paper

Every "absent from the record" claim is relative to a record whose limits the
paper states: RPW 1998/1 is not machine-readable (its body carries no item
headings); before 2009 the only WEKO source is RPW; cantonal civil judgments
enter as tier 2 and are whatever the cantons publish, which is not a complete
census of civil competition litigation; merger decisions are in the record but
not the object of the audit; the statutory text is point-in-time from
2001-01-01, because Fedlex publishes no text for the editions before it
(3.3), and the paper reports the version count it actually used.

## 4. Method

### 4.1 Unit of analysis

A **proposition**: one numbered Ziffer of the Bekanntmachung, or one paragraph
of the Erläuterungen. Propositions are aligned across versions into a single
table (added / unchanged / reworded / removed), so a proposition carries the
date it first entered the instrument.

### 4.2 Retrieval

For each proposition, candidates come from the record in two passes: Postgres
full-text search over `ch_court_decisions` for the top 50, then a re-rank with
bge-m3 embeddings (the `tei-bge-m3-lawrider` service already runs on cthulhu;
no new Qdrant collection is needed at this size). The unit handed to the
annotator is a passage, not a whole decision.

### 4.3 Labels

- **supported** — an authority applies the proposition as the rule it decides on;
- **fragment** — the record holds part of it, or states it in passing, or cites
  it without applying it;
- **absent** — no support in the record.

Each label carries the **tier** its evidence came from: WEKO's own decisions
and the federal courts reviewing them (tier 1), or cantonal civil judgments
applying the same provision (tier 2). Results are reported per tier and
combined; a proposition supported only in tier 2 is a different finding from
one the agency's own record holds, and the paper must not blur the two.

Each label also carries the **statutory regime** it was judged under, so that
support found under a different regime than the proposition rests on is
visible rather than silently counted (see 3.3).

### 4.4 The two measurements that answer the question

1. **Codification or announcement.** For supported propositions, the earliest
   supporting decision is compared with the date of the version that introduced
   the proposition. Practice first = codification; text first = announcement,
   and then: did the record catch up, and how long did it take? Retrieval for
   this measurement is restricted to decisions issued **before** the version
   date; a later decision cannot justify an earlier text.
2. **Provenance of the wording.** Each proposition is aligned against the EU
   guidelines and block exemption regulations (n-gram overlap plus local
   alignment). Three classes: grounded in Swiss practice, imported EU wording,
   WEKO's own novel statement.

A short third measurement: does the instrument cite the Swiss record at all,
and where it does, does the cited decision hold the proposition (this is
Schrepel & Jenny's citation-anchor test, which in Switzerland may find few
citations to anchor).

### 4.5 Annotation

First pass by an LLM judge on Bedrock (project standard), required to return
the quotes its label rests on. Then human verification of a stratified sample.

**The protocol is written once and frozen before the run.** If it turns out to
be incomplete, the rule is changed and everything is re-annotated from scratch;
clarifications are never appended mid-run, because a protocol that drifts
produces labels that cannot be compared with each other.

## 5. Validity controls

Run and reported **before** the main pass. The instrument is verified before
the text is.

1. **Retrieval recall.** Propositions whose supporting decisions are known in
   advance (from the footnotes the Erläuterungen do carry, and from the
   commentary corpus) must have those decisions in the top k. A miss rate here
   invalidates every "absent" label, and the fix is the retrieval, not the label.
2. **Gold set before the model.** ~50 propositions annotated by hand before any
   model runs and held out of prompt development.
3. **Double annotation and agreement.** A stratified sample annotated twice,
   agreement reported (Cohen's kappa), disagreements resolved against the
   written rule.
4. **Negative controls.** Fabricated propositions and propositions from an
   unrelated instrument (the merger notice) must come back *absent*.
5. **Positive controls.** Propositions that restate the statute verbatim
   (Art. 5 KG) must come back *supported*, with many hits.
6. **Model sensitivity.** The judge is run with two models and with the evidence
   order permuted; label stability is reported.
7. **No look-ahead.** Enforced in the query, not by instruction to the judge.
8. **Provenance threshold calibrated.** Overlap is measured on unrelated text
   pairs first, to establish what overlap level is noise.
9. **Regime control.** A sample of propositions that rest on Art. 5 para. 4 is
   checked against pre-2004 decisions: the pipeline must return *absent* for
   them. If it returns support, the retrieval is matching topic rather than
   rule.
10. **Every figure in the paper is recomputed from the published artifacts at
   the end**, never carried over from intermediate notes.

## 6. Paper structure

1. Introduction: the question and the finding.
2. Why Switzerland: the status of a Bekanntmachung, and the three possible
   sources of a proposition in a small jurisdiction.
3. Data and method, with the coverage tables.
4. Results: the map of propositions by label and evidence tier; codification
   against announcement over time, with the 2004 statutory break marked;
   provenance of wording; whether the instrument cites its own record.
5. Two or three contested provisions read closely.
6. Implications: legitimacy; what an agency should publish alongside a notice;
   and the audit as a repeatable instrument — the script re-runs on each new
   version.
7. Limitations.
8. Artifacts: the annotated proposition table and the code.

## 7. Artifacts

- Dataset: propositions × versions × labels × earliest supporting decision ×
  EU overlap, with the evidence passages.
- Code: the retrieval, judge and provenance scripts, in the repository.
- Both published with the paper, as the venue's own work does.

## 8. Risks

| Risk | Handling |
|---|---|
| Retrieval misses support that exists | Control 1 gates the run; recall reported in the paper |
| Judge agrees with whatever it is shown | Controls 4 and 5; gold set; two models |
| The notice cites nothing, so the citation test is empty | It becomes a finding, reported as one paragraph, not a section |
| Corpus gaps read as absence of practice | Section 3.4 is stated in the paper, not in a footnote |
| Support counted across a statutory break | Section 3.3: the regime is part of the label, and control 9 tests it |
| Cantonal civil support read as agency practice | The tier is part of every label and every table |
| Result is "everything is grounded" | Publishable as a negative result; see section 1 |
| Scope creep to the other notices | v1 is vertical restraints only; the rest are follow-ups |

## 9. Sequence

1. Extend the RPW cut to chapter-level items; load part D1; extract every
   version of the notice and the Erläuterungen.
2. Statute editions: verified 2026-09-23, nothing to fetch — the 1996
   editions have no machine-readable text at the source (3.3). Re-check each
   act's version count against Fedlex SPARQL per act, not as a global
   assumption, for the acts the audit does quote.
3. Acquire the EU texts. Pin the KG versions by `act_id`, and record which
   version was in force for each instrument version.
4. Build the proposition table with cross-version alignment.
5. Build retrieval; run control 1; fix until recall is acceptable.
6. Hand-annotate the gold set; freeze the protocol.
7. Run the judge; run controls 3-6 and 9.
8. Compute the two measurements.
9. Write the paper; recompute every figure from the artifacts.
10. Send the final draft to Schrepel, who offered comments and help with the
   publication strategy (22.09.2026).
