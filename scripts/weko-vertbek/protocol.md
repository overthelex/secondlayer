# Reading protocol: the WEKO vertical-restraints audit

Version 2, frozen 2026-10-02. Version 1 (2026-10-01) was replaced after a
blind check: on 14 propositions the judges' majority matched the human
reader on 7. They read "partial" where the reader read "recites", because
version 1 did not say where restating a rule ends and using it begins. The
rules below are written from the reader's reasons on 17 propositions
(changes listed at the end). Every label is made again under this version;
a clarification is never added in the middle of a run.

## What is judged

One **proposition** of the Swiss vertical-restraints notice (Bekanntmachung
or Erläuterungen, a given version) against **eight passages** from eight
different decisions of the Swiss record: the Competition Commission (WEKO)
and its Secretariat, the federal courts, cantonal courts and a few other
authorities. A lettered point may come with the opening of its sentence,
marked as context; the proposition is the lettered point.

The question for every passage is the same:

> Does this passage show the rule the proposition states being **used to
> decide something**, and is that use **visible in the passage itself**?

## Five labels per passage

**applies**: the rule is applied to the case and the **legal consequence is
visible in the passage**: the presumption is rebutted or not, the clause is
or is not a hardcore restriction, the argument is rejected because of the
rule. The rule may be applied without the notice being named, and in the
decision's own words; a predecessor version of the same rule (the notice of
2007 or 2010 for a 2022 proposition) counts as the same rule.

**partial**: a step with the rule is visible, but not the whole way to a
consequence:
- the facts are qualified under the rule (these clauses are parity clauses
  of this kind) but no legal consequence follows in the passage;
- the decision derives or justifies the rule itself in its own reasoning,
  or sets it up as the test for the step it is taking (after rebutting the
  presumption, "therefore lit. a applies as the standard"), and the
  subsumption lies outside the passage;
- only part of the proposition is used, or a narrower or neighbouring rule
  that covers part of it, including the reverse side of the rule (maximum
  prices are generally harmless, so a price recommendation acting like one
  is too).

**contradicts**: the passage decides the matter of the proposition by the
opposite rule, departs from it, or holds it inapplicable where it claims to
apply.

**recites**: the rule is restated, quoted, paraphrased or listed, and
nothing is done with it **in the passage**. This holds even when:
- the decision states the rule as the law governing its case and the
  subsumption follows after the passage ends ("Vorliegend ...", a heading,
  then the window stops);
- a court reproduces WEKO's position on the rule without taking it up;
- the rule appears in a footnote, as an "Orientierungshilfe", or as a
  statement that Swiss practice follows the EU texts;
- the passage defines the notice's terms without using them.

**unrelated**: the passage is about something else:
- **another rule of the same notice**, including another letter or
  paragraph of the same article (Art. 15 lit. c is not Art. 15 lit. b; the
  Art. 5 para. 4 presumption is not the qualitative seriousness of Art. 15);
- **the same words for another legal question**: "platforms mediate
  transactions" used for market definition or two-sided markets is not the
  qualification as an online intermediation service under the notice;
  Geschäftsgeheimnis in a transparency case is not Know-how; horizontal
  agreements, Art. 7 KG (dominance), merger control and ancillary
  restraints, procedure and publication are other questions;
- a match on vocabulary only (dates, contract terms, "Vertrag").

## Order of questions

Stop at the first yes:

1. Is the passage about **this** rule (not another letter, not another legal question)? No → **unrelated**.
   A neighbouring rule that covers part of the same matter (maximum prices for a proposition on price
   recommendations) counts as about it; a rule on a different matter does not.
2. Is anything done with the rule **in the passage**, beyond restating it? No → **recites**.
3. Does the decision go against the rule? Yes → **contradicts**.
4. Is the **whole** rule applied, with its legal consequence for the case visible in the passage?
   No → **partial** (consequence missing, or only part of the proposition, or a neighbouring rule).
5. Otherwise → **applies**.

## Where it goes wrong

- **The consequence can be one clause.** "..., weshalb die Abrede als
  qualitativ schwerwiegend gilt" after a restated rule is applies.
- **The rule announced, the window ends.** A passage that states the rule
  and then "Vorliegend bestehen folgende Abreden:" or a heading, with the
  conclusion cut off, is recites. A fragment of the conclusion ("... von
  Art. 5 Abs. 4 KG erfasst werden") without its subject is not counted.
- **A court finding that WEKO breached the rule** is applies: the rule is
  the yardstick. Contradicts is kept for a decision that adopts the
  opposite rule.
- **Dates and regimes are shown, not judged.** A passage decided before the
  version, or under the 1995 act, is labelled by what it does.
- **A provision that did not exist yet.** A decision under an earlier
  version of the cartel act cannot apply a paragraph introduced later (Art. 5
  para. 4 KG and direct sanctions date from 1 April 2004). If it reaches a
  similar result through another provision, that is partial.
- **Statute text.** If the proposition repeats a paragraph of Art. 5 KG, a
  passage applying that paragraph with a visible consequence applies it.
- **The window is cut.** Passages are windows of about 1,200 characters;
  journal passages may come in two pieces joined by "[…]". Judge what is
  visible; if it is not enough to say, the weaker label.
- **Redactions** ("[…]" inside a sentence) are business secrets removed for
  publication. Judge the reasoning around them.
- **Language.** Passages may be in French or Italian. Quote in the
  language printed.
- **Borderline cases** go to the weaker label, with the reason in one line.

## The proposition's label

Derived, not chosen:

- **supported**: at least one passage applies it;
- **fragment**: none applies, at least one is partial;
- **recites**: none applies or is partial, at least one recites;
- **absent**: every passage is unrelated or contradicts.

A passage that contradicts never supports; contradictions are counted
separately. The reader marks the passages that carry the label ("stützt");
the judge returns, for every passage that applies, is partial or
contradicts, a verbatim quote of the words that show it.

## What is deliberately not shown

Whether the decision cites the notice, how much of the proposition it
reproduces by the formal measure, and whether the item is a control.

## When unsure

Choose the weaker label (partial over applies, recites over partial,
unrelated over recites when the rule is another one).

## Changes from version 1 (2026-10-01)

Written from the reader's reasons on the 17 propositions labelled on
2026-10-02 (human_labels_2026-10-02.json). Those 17 are therefore the
development set for this version; the blind check of version 2 is drawn
from the other propositions.

1. A consequence must be visible in the passage; a rule restated as the law
   of the case with the subsumption outside the window is recites, not
   partial (2002 Ziff. 2, 2022 Art. 12(3), 15(d), 17, Erl. Rz 12).
2. Partial is defined by what is visible: a qualification without a
   consequence (Erl. Rz 33), a rule derived or set up as the test of a step
   (2022 IX), a neighbouring or reverse-side rule (Erl. Rz 7).
3. Another letter or paragraph of the same article is another rule (2010
   Ziff. 8(2b), 2022 Art. 15(d), IX).
4. The notice's words used for another legal question are unrelated (2022
   Art. 9: market definition; Erl. Rz 33: Art. 7 "Preise und
   Geschäftsbedingungen").
5. Footnotes, "Orientierungshilfe", EU parallelism and a court reproducing
   WEKO's position are recites (2022 VI, 17; 2002 Ziff. 2).
6. Input corrected alongside (not protocol): footnotes and their
   continuation lines removed from the Erläuterungen (they carried case
   citations into the propositions), the opening sentence shown with
   lettered points, BGE dated by the judgment instead of the volume year.
