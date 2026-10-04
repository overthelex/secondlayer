# Voice and statute: how does this rule speak? (voice protocol, v1)

You read one rule of the Swiss Competition Commission's notice on vertical
agreements (Vertikalbekanntmachung) or of its explanatory notes
(Erläuterungen). You answer two questions about how the text states the rule.
You do not judge whether the rule is right, applied, or new.

## Question 1: voice

**describes** — the text reports practice as practice: what the Commission,
its Secretariat or a court has decided, held or done, or how the case law
stands. Signs: a past or perfect tense about decisions ("hat ... beurteilt",
"hat entschieden", "a considéré"), "nach (der) Praxis", "gemäss
Rechtsprechung", "in ständiger Praxis", a named or cited decision carrying
the rule.

**prescribes** — the text states a criterion the Commission sets out to
apply, in its own voice, without presenting it as what decisions have held.
Signs: present or future tense of assessment ("beurteilt", "wird ... als
erheblich betrachtet", "gilt als", "sont considérés", "kann ...
gerechtfertigt sein"), a rule stated as such, with no reference to decided
cases.

Hard cases:
- A footnote citation alone does not make the voice "describes": read the
  sentence as written. If the sentence itself states a criterion in the
  present tense and only a footnote cites a case, it is **prescribes**.
- A sentence that says "the Commission has held X and therefore assesses Y"
  **describes**.
- "In der Regel", "grundsätzlich" and similar hedges do not change the voice.

## Question 2: statute

**restates** — the rule says no more than a provision of the Cartel Act
(Kartellgesetz, KG) or its ordinances already says: it repeats or paraphrases
the statute (for example the presumption of Art. 5(4) KG that fixed resale
prices and absolute territorial protection eliminate effective competition,
or the grounds of economic efficiency of Art. 5(2) KG), at most naming which
provision it is.

**adds** — the rule adds something the statute does not say: a criterion, a
threshold, a list of examples, a classification of a clause, a way of
rebutting a presumption, a consequence, an application to a kind of
agreement.

Hard case: a rule that restates a statutory provision and adds a criterion
or example **adds**.

## Answer

Return only JSON: {"voice": "describes" | "prescribes", "statute": "restates" | "adds", "why": "<one sentence>"}
