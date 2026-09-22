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

**Out of scope for v1.** The SME notice (KMU-Bekanntmachung) and the motor
vehicle notice; cantonal civil practice (RPW parts C1/C2); merger control.
Each is a follow-up that the same pipeline can run.

## 3. Data

### 3.1 What exists

| Source | State | Notes |
|---|---|---|
| WEKO decisions 1995–2025 | **1,537 loaded** (`spider = CH_WEKO_RPW`) | cut from the RPW journal, PR #2451/#2452 |
| WEKO files from entscheidsuche | 117 (`spider = CH_WEKO`) | 62 RPW documents point at one via `metadata_json.rpw.same_as` |
| BVGer / BGer / BGE | in `ch_court_decisions` | competition matters selected by statute references and full text; 51 of them name the vertical notice or vertical agreements outright |
| Swiss scholarly commentary | 1,564 rows (`ch_commentary`) | used to build the retrieval-recall check, not as evidence |
| Kartellgesetz, all editions | `ch_act_version` | point-in-time text for the statutory-anchor control |

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

### 3.3 Corpus completeness, stated in the paper

Every "absent from the record" claim is relative to a record whose limits the
paper states: RPW 1998/1 is not machine-readable (its body carries no item
headings); before 2009 the only source is RPW; cantonal civil practice is
excluded; merger decisions are in the record but not the object of the audit.

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
9. **Every figure in the paper is recomputed from the published artifacts at
   the end**, never carried over from intermediate notes.

## 6. Paper structure

1. Introduction: the question and the finding.
2. Why Switzerland: the status of a Bekanntmachung, and the three possible
   sources of a proposition in a small jurisdiction.
3. Data and method, with the coverage tables.
4. Results: the map of propositions by label; codification against
   announcement over time; provenance of wording; whether the instrument cites
   its own record.
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
| Corpus gaps read as absence of practice | Section 3.3 is stated in the paper, not in a footnote |
| Result is "everything is grounded" | Publishable as a negative result; see section 1 |
| Scope creep to the other notices | v1 is vertical restraints only; the rest are follow-ups |

## 9. Sequence

1. Extend the RPW cut to chapter-level items; load part D1; extract every
   version of the notice and the Erläuterungen.
2. Acquire the EU texts.
3. Build the proposition table with cross-version alignment.
4. Build retrieval; run control 1; fix until recall is acceptable.
5. Hand-annotate the gold set; freeze the protocol.
6. Run the judge; run controls 3-6.
7. Compute the two measurements.
8. Write the paper; recompute every figure from the artifacts.
9. Send the final draft to Schrepel, who offered comments and help with the
   publication strategy (22.09.2026).
