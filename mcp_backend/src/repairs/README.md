# Repairs

A **migration** says what a deployment *is*. Every deployment needs it, it runs
automatically, and once recorded it never runs again — so it can never be
corrected in place.

A **repair** fixes damage that happened to a particular database at a particular
time. A deployment that never had the damage must not run it.

Mixing the two means the fix for one box's incident ships to every box, during a
deploy, unwatched. On 2026-09-19 that happened: a repair written for the UK
corpus ran against legal.org.ua as an ordinary migration. It matched nothing —
by luck; its predicate was wrong and could have matched — and being recorded in
`schema_migrations` it could not be edited, so correcting it needed a second
migration to undo the first.

## Running one

```
.github/workflows/run-repair.yml   →   repair, target, dry run
```

Dry run is the default and executes for real inside a transaction that is rolled
back, so the row counts you see are the true ones. The predicate is the part
that is usually wrong; nothing else tells you that before it is too late.

## Writing one

- **Idempotent.** It will be run twice, because someone will want to be sure.
- **No `BEGIN`/`COMMIT`/`ROLLBACK`.** The runner supplies the transaction; a
  `COMMIT` in the file would survive a dry run, which is the one thing a dry run
  must not allow. A test enforces this.
- **Say what happened.** The header should carry the incident, the measurement
  that justified the predicate, and what was measured on each database before
  running. A repair with no numbers in it cannot be checked by the next person.
- **Name it by date and subject**, not by a migration number: it is not part of
  any sequence.

## What still belongs in migrations

Seed and reference data — tool pricing, sync sources — even though those are
`INSERT`/`UPDATE` statements. A deployment without them is not a working
deployment, so they describe what it *is*. The test in
`../migrations/__tests__/migrations-are-not-repairs.test.ts` draws the line at
corpus tables rather than at DML.
