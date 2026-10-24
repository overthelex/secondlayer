#!/usr/bin/env python3
"""Import the harvested NIPO/UIPV NDJSON tree into a single unified Postgres
table `ip_objects`.

Input: the directory tree produced by harvest_nipo.py -
    harvest/<type_slug>/<state_slug>/<YYYY-MM>.ndjson
    type_slug  in {inventions, utility_models, trademarks, designs}
    state_slug in {applications, registered}
obj_type and obj_state are inferred from the path, so each raw API record maps
to exactly one unified row.

Why one table (vs the legacy opendata_trademarks / opendata_patents pair):
  * covers ALL four object types AND both states (the legacy importer only did
    obj_state=2 and lumped utility models + designs together);
  * a single `owner_*` block with a `owner_role` discriminator (applicant vs
    holder) instead of split holder_*/applicant_* columns - the "unified owner"
    the task calls for;
  * classes normalised into one `classes text[]` + `class_system`
    (nice | ipc | locarno) so the collision-search tool (#4) can GIN-filter by
    class regardless of object type;
  * registration_* / expiry_date are nullable (absent on applications);
  * application-only bulletin fields (Code_441) captured;
  * raw_data kept as jsonb so nothing is lost.

Safety: the DB target is env-driven and printed loudly on startup. It does NOT
default to the prod loopback port - use --dry-run to validate extraction with
no DB at all, and set POSTGRES_* explicitly for a real load.

Usage:
  python3 import_ndjson.py --dry-run --limit 3           # inspect extraction
  python3 import_ndjson.py --create-schema               # DDL only
  python3 import_ndjson.py                               # full load
  python3 import_ndjson.py --harvest-dir harvest/trademarks   # subtree only
"""

import argparse
import glob
import json
import os
import re
import sys

DEFAULT_HARVEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "harvest")

TYPE_SLUGS = {"inventions": 1, "utility_models": 2, "trademarks": 4, "designs": 6}
TYPE_NAMES = {1: "Винаходи", 2: "Корисні моделі", 4: "Торговельні марки", 6: "Промислові зразки"}
STATE_SLUGS = {"applications": 1, "registered": 2}
CLASS_SYSTEM = {1: "ipc", 2: "ipc", 4: "nice", 6: "locarno"}

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS ip_objects (
    id                  BIGSERIAL PRIMARY KEY,
    obj_type            SMALLINT NOT NULL,
    obj_type_name       TEXT,
    obj_state           SMALLINT NOT NULL,
    app_number          TEXT NOT NULL,
    app_date            DATE,
    registration_number TEXT,
    registration_date   DATE,
    expiry_date         DATE,
    status              TEXT,
    title_ua            TEXT,
    title_en            TEXT,
    abstract_ua         TEXT,
    class_system        TEXT,
    classes             TEXT[],
    owner_name          TEXT,
    owner_edrpou        TEXT,
    owner_country       TEXT,
    owner_kind          TEXT,
    owner_role          TEXT,
    inventor_names      TEXT[],
    image_path          TEXT,
    image_object_key    TEXT,
    bulletin_441_date   TEXT,
    bulletin_441_number TEXT,
    last_update         TIMESTAMPTZ,
    raw_data            JSONB,
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (app_number, obj_type, obj_state)
);
CREATE INDEX IF NOT EXISTS idx_ip_objects_classes     ON ip_objects USING GIN (classes);
CREATE INDEX IF NOT EXISTS idx_ip_objects_owner_edrpou ON ip_objects (owner_edrpou) WHERE owner_edrpou IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ip_objects_reg_number  ON ip_objects (registration_number) WHERE registration_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ip_objects_app_number  ON ip_objects (app_number);
CREATE INDEX IF NOT EXISTS idx_ip_objects_type_state  ON ip_objects (obj_type, obj_state);
CREATE INDEX IF NOT EXISTS idx_ip_objects_title_trgm  ON ip_objects USING GIN (title_ua gin_trgm_ops);
"""

CREATE_EVENTS_SQL = """
CREATE TABLE IF NOT EXISTS ip_object_events (
    id          BIGSERIAL PRIMARY KEY,
    app_number  TEXT NOT NULL,
    obj_type    SMALLINT,
    obj_state   SMALLINT,
    event_date  DATE,
    event_kind  TEXT,
    doc_type    TEXT,
    direction   TEXT,
    doc_number  TEXT,
    doc_cead_id BIGINT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (doc_cead_id)
);
CREATE INDEX IF NOT EXISTS idx_ip_events_app  ON ip_object_events (app_number);
CREATE INDEX IF NOT EXISTS idx_ip_events_kind ON ip_object_events (event_kind);
"""

# DocType (free-text) -> lifecycle event kind. Order matters: first match wins.
# Derived from the real registered-trademark DocType vocabulary in the SIS API.
EVENT_RULES = [
    ("invalidation", ("недійсн",)),                       # визнання недійсним
    ("termination",  ("припин",)),                        # припинення дії
    ("renewal",      ("продовж", "поновл", "відновл")),   # продовження строку дії
    ("registration", ("рішення про реєстрац", "реєстрацію знака", "видача свідоцтва",
                      "видачу охоронного", "рішення про видачу")),
    ("amendment",    ("внесення змін",)),                 # зміни до реєстру
    ("refusal",      ("відмов",)),                        # відмова в реєстрації
]

EVENT_COLUMNS = ["app_number", "obj_type", "obj_state", "event_date", "event_kind",
                 "doc_type", "direction", "doc_number", "doc_cead_id"]


def classify_doctype(doc_type):
    low = (doc_type or "").lower()
    for kind, keys in EVENT_RULES:
        if any(k in low for k in keys):
            return kind
    return None


def extract_events(record, obj_type, obj_state):
    """Yield lifecycle-event rows from a record's data_docs (skips pure
    correspondence — only classified продовження/недійсність/припинення/… kept)."""
    rows = []
    for d in record.get("data_docs") or []:
        dr = d.get("DocRecord") or {}
        kind = classify_doctype(dr.get("DocType"))
        cead = dr.get("DocIdDocCEAD")
        if not kind or cead is None:
            continue
        rows.append((
            record.get("app_number"), obj_type, obj_state,
            _date(dr.get("DocRegDate")), kind, dr.get("DocType"),
            dr.get("DocDirection"), dr.get("DocRegNumber"), cead,
        ))
    return rows


COLUMNS = [
    "obj_type", "obj_type_name", "obj_state", "app_number", "app_date",
    "registration_number", "registration_date", "expiry_date", "status",
    "title_ua", "title_en", "abstract_ua", "class_system", "classes",
    "owner_name", "owner_edrpou", "owner_country", "owner_kind", "owner_role",
    "inventor_names", "image_path", "bulletin_441_date", "bulletin_441_number",
    "last_update", "raw_data",
]


def _date(v):
    return (v or "")[:10] or None if isinstance(v, str) else None


def _values_one_lang(blocks, base):
    """Collect values for `base` from an INID list, using a SINGLE language for
    the whole list (prefer .U, then .R, then .E). The API repeats each party /
    inventor once per language, so picking one language avoids triple-counting.
    """
    for suf in (".U", ".R", ".E"):
        vals = [e.get(base + suf) for e in blocks or [] if e.get(base + suf)]
        if vals:
            return vals
    return []


def _party_from_inid(blocks, name_base, country_base):
    """Extract (primary name, country) from an I_71/I_73 style list."""
    names = _values_one_lang(blocks, name_base)
    countries = _values_one_lang(blocks, country_base)
    return (names[0] if names else None), (countries[0] if countries else None)


def mark_title(verbal):
    """Display text of a trademark from MarkSignificantVerbalElement (LEXAI-2103).

    NIPO lists the full phrase AND each of its words as separate elements
    («відновлення», «сила», ..., «моршинська. моя сила відновлення.»); joining them
    all produced a token bag. Drop an element another one already covers (all its
    words occur in a longer element, same text up to punctuation/case, or a 1-2 char
    fragment of a longer one) and join the distinct rest with " / ".
    Mirror of deriveMarkTitle() in mcp_backend/src/api/tools/ip-objects-tools.ts.
    """
    if isinstance(verbal, dict):
        verbal = [verbal]
    if not isinstance(verbal, list):
        return None
    items = []
    for i, v in enumerate(verbal):
        text = v if isinstance(v, str) else (v or {}).get("#text")
        text = " ".join(str(text or "").split())
        if not text:
            continue
        try:
            seq = int((v or {}).get("@sequenceNumber") or 0) if isinstance(v, dict) else 0
        except (TypeError, ValueError):
            seq = 0
        lower = text.lower()
        tokens = [t for t in re.split(r"[\W_]+", lower) if t]
        items.append({"text": text, "seq": seq or i + 1, "i": i, "lower": lower,
                      "tokens": tokens, "set": set(tokens), "compact": "".join(tokens)})
    if not items:
        return None
    items.sort(key=lambda x: (x["seq"], x["i"]))

    def covers(f, e):
        if f is e:
            return False
        if not e["compact"]:
            return len(f["lower"]) > len(e["lower"]) and e["lower"] in f["lower"]
        if f["compact"] == e["compact"]:
            return f["i"] < e["i"]
        if len(f["tokens"]) > len(e["tokens"]) and all(t in f["set"] for t in e["tokens"]):
            return True
        return len(e["compact"]) <= 2 and len(f["compact"]) > len(e["compact"]) and e["compact"] in f["compact"]

    kept = [e for e in items if not any(covers(f, e) for f in items)]
    return " / ".join(x["text"] for x in kept) or None


def extract_trademark(record, obj_state):
    data = record.get("data") or {}

    wm = (data.get("WordMarkSpecification") or {}).get("MarkSignificantVerbalElement")
    mark_text = mark_title(wm)

    classes = []
    gs = ((data.get("GoodsServicesDetails") or {}).get("GoodsServices") or {})
    cds = (gs.get("ClassDescriptionDetails") or {}).get("ClassDescription")
    if isinstance(cds, dict):
        cds = [cds]
    for c in cds or []:
        cn = c.get("ClassNumber")
        if cn is not None:
            classes.append(str(cn))

    # Unified owner: holder if present (registered), else applicant.
    owner_name = owner_edrpou = owner_country = owner_kind = owner_role = None
    holders = (data.get("HolderDetails") or {}).get("Holder") or []
    applicants = (data.get("ApplicantDetails") or {}).get("Applicant") or []
    party = None
    if holders:
        party, owner_role = (holders[0].get("HolderAddressBook") or {}), "holder"
    elif applicants:
        party, owner_role = (applicants[0].get("ApplicantAddressBook") or {}), "applicant"
    if party is not None:
        fna = party.get("FormattedNameAddress") or {}
        fn = (fna.get("Name") or {}).get("FreeFormatName") or {}
        owner_name = (fn.get("FreeFormatNameDetails") or {}).get("FreeFormatNameLine") or None
        owner_edrpou = fn.get("EDRPOU") or None
        owner_kind = fn.get("NameKind") or None
        owner_country = (fna.get("Address") or {}).get("AddressCountryCode") or None

    image_path = ((data.get("MarkImageDetails") or {}).get("MarkImage") or {}).get("MarkImageFilename")

    return {
        "title_ua": mark_text, "title_en": None, "abstract_ua": None,
        "classes": classes or None,
        "owner_name": owner_name, "owner_edrpou": owner_edrpou,
        "owner_country": owner_country, "owner_kind": owner_kind, "owner_role": owner_role,
        "inventor_names": None,
        "image_path": image_path,
        "expiry_date": _date(data.get("ExpiryDate")),
        "status": data.get("application_status") or data.get("registration_status_color"),
        "bulletin_441_date": data.get("Code_441"),
        "bulletin_441_number": data.get("Code_441_BulNumber"),
    }


def extract_patentlike(record, obj_type, obj_state):
    """Inventions (1), utility models (2), designs (6) - WIPO INID coded."""
    data = record.get("data") or {}

    title_ua = title_en = None
    for t in data.get("I_54") or []:
        title_ua = title_ua or t.get("I_54.U")
        title_en = title_en or t.get("I_54.E")

    abstract_ua = None
    for a in data.get("AB") or []:
        if a.get("AB.L") == "UA" and a.get("AB.T"):
            abstract_ua = a.get("AB.T")
            break

    if obj_type == 6:
        classes = data.get("I_51") or data.get("Locarno") or data.get("IPC") or []
    else:
        classes = data.get("IPC") or []
    if isinstance(classes, str):
        classes = [classes]
    classes = [str(c) for c in classes if c]

    # Unified owner: holder I_73 (granted) else applicant I_71.
    if data.get("I_73"):
        owner_name, owner_country = _party_from_inid(data.get("I_73"), "I_73.N", "I_73.C")
        owner_role = "holder"
    else:
        owner_name, owner_country = _party_from_inid(data.get("I_71"), "I_71.N", "I_71.C")
        owner_role = "applicant"

    inventors = []
    for nm in _values_one_lang(data.get("I_72"), "I_72.N"):
        if nm not in inventors:
            inventors.append(nm)

    return {
        "title_ua": title_ua, "title_en": title_en, "abstract_ua": abstract_ua,
        "classes": classes or None,
        "owner_name": owner_name, "owner_edrpou": None,
        "owner_country": owner_country, "owner_kind": None, "owner_role": owner_role,
        "inventor_names": inventors or None,
        "image_path": None,
        "expiry_date": None,
        "status": data.get("registration_status_color") or data.get("application_status"),
        "bulletin_441_date": None,
        "bulletin_441_number": None,
    }


def extract_row(record, obj_type, obj_state):
    if obj_type == 4:
        spec = extract_trademark(record, obj_state)
    else:
        spec = extract_patentlike(record, obj_type, obj_state)
    row = {
        "obj_type": obj_type,
        "obj_type_name": TYPE_NAMES.get(obj_type),
        "obj_state": obj_state,
        "app_number": record.get("app_number"),
        "app_date": _date(record.get("app_date")),
        "registration_number": record.get("registration_number"),
        "registration_date": _date(record.get("registration_date")),
        "class_system": CLASS_SYSTEM.get(obj_type),
        "last_update": record.get("last_update"),
        "raw_data": json.dumps(record.get("data") or {}, ensure_ascii=False),
    }
    row.update(spec)
    return tuple(row[c] for c in COLUMNS)


def iter_ndjson_files(harvest_dir):
    """Yield (path, obj_type, obj_state) for every ndjson under the tree."""
    for path in sorted(glob.glob(os.path.join(harvest_dir, "**", "*.ndjson"), recursive=True)):
        parts = path.split(os.sep)
        type_slug = next((p for p in parts if p in TYPE_SLUGS), None)
        state_slug = next((p for p in parts if p in STATE_SLUGS), None)
        if type_slug is None or state_slug is None:
            print(f"  WARN skip (cannot infer type/state): {path}")
            continue
        yield path, TYPE_SLUGS[type_slug], STATE_SLUGS[state_slug]


def get_db_conn():
    import psycopg2
    host = os.environ.get("POSTGRES_HOST", "127.0.0.1")
    port = int(os.environ.get("POSTGRES_PORT", "5432"))
    db = os.environ.get("POSTGRES_DB", "secondlayer")
    user = os.environ.get("POSTGRES_USER", "secondlayer")
    print(f"  DB target: postgresql://{user}@{host}:{port}/{db}")
    return psycopg2.connect(host=host, port=port, dbname=db, user=user,
                            password=os.environ.get("POSTGRES_PASSWORD"))


def run(args):
    files = list(iter_ndjson_files(args.harvest_dir))
    print(f"Found {len(files)} ndjson window files under {args.harvest_dir}")

    if args.dry_run:
        shown = 0
        total = 0
        for path, ot, ost in files:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    total += 1
                    if shown < args.limit:
                        row = dict(zip(COLUMNS, extract_row(json.loads(line), ot, ost)))
                        row.pop("raw_data")
                        print(json.dumps(row, ensure_ascii=False, indent=2))
                        shown += 1
        print(f"\nDRY RUN: parsed {total} records across {len(files)} files, "
              f"showed {shown}. No DB touched.")
        return

    import psycopg2.extras
    conn = get_db_conn()
    cur = conn.cursor()
    # ip_object_events is cheap and needed even by --no-schema watcher runs.
    cur.execute(CREATE_EVENTS_SQL)
    conn.commit()
    if args.create_schema or not args.no_schema:
        cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm;")
        cur.execute(CREATE_SQL)
        conn.commit()
        print("  schema ensured (ip_objects + ip_object_events + indexes)")
    if args.create_schema:
        cur.close(); conn.close(); return

    upsert = f"""
        INSERT INTO ip_objects ({','.join(COLUMNS)})
        VALUES %s
        ON CONFLICT (app_number, obj_type, obj_state) DO UPDATE SET
            registration_number=EXCLUDED.registration_number,
            registration_date=EXCLUDED.registration_date,
            expiry_date=EXCLUDED.expiry_date,
            status=EXCLUDED.status,
            title_ua=EXCLUDED.title_ua,
            owner_name=EXCLUDED.owner_name,
            owner_edrpou=EXCLUDED.owner_edrpou,
            classes=EXCLUDED.classes,
            last_update=EXCLUDED.last_update,
            raw_data=EXCLUDED.raw_data,
            imported_at=NOW()
    """
    events_upsert = f"""
        INSERT INTO ip_object_events ({','.join(EVENT_COLUMNS)})
        VALUES %s
        ON CONFLICT (doc_cead_id) DO NOTHING
    """
    total = 0
    total_events = 0
    for path, ot, ost in files:
        batch = []
        events = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                batch.append(extract_row(rec, ot, ost))
                events.extend(extract_events(rec, ot, ost))
        if not batch:
            continue
        # SIS pagination can repeat an app_number within one window; ON CONFLICT
        # cannot touch the same row twice in one command, so dedupe by the
        # conflict key (app_number, obj_type, obj_state), keeping the last seen.
        deduped = {}
        for row in batch:
            deduped[(row[3], row[0], row[2])] = row
        batch = list(deduped.values())
        psycopg2.extras.execute_values(cur, upsert, batch, template=None, page_size=500)
        if events:
            ev_dedup = {e[8]: e for e in events}  # dedupe by doc_cead_id
            psycopg2.extras.execute_values(cur, events_upsert, list(ev_dedup.values()), page_size=500)
            total_events += len(ev_dedup)
        conn.commit()
        total += len(batch)
        print(f"  {os.path.relpath(path, args.harvest_dir)}: {len(batch)} rows (running {total})")
    cur.close(); conn.close()
    print(f"\nDONE: upserted {total} rows into ip_objects, {total_events} lifecycle events")


def parse_args():
    p = argparse.ArgumentParser(description="Import harvested NIPO NDJSON into ip_objects")
    p.add_argument("--harvest-dir", default=DEFAULT_HARVEST_DIR)
    p.add_argument("--dry-run", action="store_true", help="parse + print sample, no DB")
    p.add_argument("--limit", type=int, default=3, help="sample rows to show in --dry-run")
    p.add_argument("--create-schema", action="store_true", help="run DDL then exit")
    p.add_argument("--no-schema", action="store_true", help="skip DDL on load")
    return p.parse_args()


if __name__ == "__main__":
    run(parse_args())
