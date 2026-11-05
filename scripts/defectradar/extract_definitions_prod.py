#!/usr/bin/env python3
"""
Stage 1 (prod): Extract legal definitions from rada.legislation on prod.

Connects to prod DB via SSH tunnel and extracts definitions from
full_text_plain and articles JSONB fields.

Output: definitions.jsonl
"""

import json
import os
import re
import sys
from dataclasses import dataclass, asdict
from typing import Optional

import psycopg2
from tqdm import tqdm


@dataclass
class Definition:
    rada_id: str
    law_title: str
    article_number: str
    definiendum: str
    genus_proximum: str
    differentia_specifica: str
    full_definiens: str
    raw_text: str
    extraction_method: str


DEFINITION_BLOCK_PATTERNS = [
    re.compile(r"визначення\s+термін", re.IGNORECASE),
    re.compile(r"терміни\s+та\s+їх\s+визначення", re.IGNORECASE),
    re.compile(r"основні\s+терміни", re.IGNORECASE),
    re.compile(r"терміни\s+вживаються\s+в\s+такому\s+значенні", re.IGNORECASE),
    re.compile(r"у\s+цьому\s+(Законі|Кодексі)\s+.{0,50}терміни", re.IGNORECASE),
    re.compile(r"для\s+цілей\s+цього", re.IGNORECASE),
    re.compile(r"наведені нижче терміни", re.IGNORECASE),
    re.compile(r"такі\s+терміни", re.IGNORECASE),
]

# Split definitions at semicolon followed by newline+capital or just capital after semicolon
SEMICOLON_SPLIT = re.compile(r";\s*\n\s*(?=[А-ЯІЇЄҐ])")
SEMICOLON_INLINE_SPLIT = re.compile(r";\s+(?=[а-яіїєґА-ЯІЇЄҐ]{2,}[а-яіїєґ]+\s+[-—–])")

GENUS_PATTERN = re.compile(
    r"^(?:це\s+)?(?P<genus>(?:[а-яіїєґ']+\s+){0,3}[а-яіїєґ']+)"
    r"(?:\s*,\s*|\s+(?:який|яка|яке|які|що|де|метою|для|з|між|у)\s+)"
)


def find_definition_block(text: str) -> Optional[str]:
    """Find the definition block in a legislative text."""
    for pat in DEFINITION_BLOCK_PATTERNS:
        m = pat.search(text[:3000])
        if m:
            # Find the colon after the pattern
            rest = text[m.end():]
            colon_pos = rest.find(":")
            if colon_pos != -1 and colon_pos < 300:
                block_start = m.end() + colon_pos + 1
            else:
                block_start = m.end()

            # Find end of block: next "Стаття" or "Розділ" or double newline + heading
            block_text = text[block_start:]
            end_patterns = [
                re.compile(r"\n\s*Стаття\s+\d"),
                re.compile(r"\n\s*Розділ\s+[IVX\d]"),
                re.compile(r"\n\s*РОЗДІЛ\s+[IVX\d]"),
                re.compile(r"\n\s*Глава\s+\d"),
            ]
            end_pos = len(block_text)
            for ep in end_patterns:
                em = ep.search(block_text)
                if em and em.start() < end_pos:
                    end_pos = em.start()

            return block_text[:end_pos].strip()
    return None


def split_definitions(block: str) -> list[str]:
    """Split a definition block into individual definitions."""
    # Try semicolon + newline split
    parts = SEMICOLON_SPLIT.split(block)
    if len(parts) > 2:
        return [p.strip() for p in parts if len(p.strip()) > 15]

    # Try inline semicolon split
    parts = SEMICOLON_INLINE_SPLIT.split(block)
    if len(parts) > 2:
        return [p.strip() for p in parts if len(p.strip()) > 15]

    # Try newline-based split (line starts with term + dash)
    lines = block.split("\n")
    definitions = []
    current = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if current:
                definitions.append(" ".join(current))
                current = []
            continue

        # New definition starts with a term followed by dash
        if re.match(r"^[а-яіїєґА-ЯІЇЄҐ'«\(]{2,}", stripped) and \
           re.search(r"\s+[-—–]\s+", stripped[:120]):
            if current:
                definitions.append(" ".join(current))
            current = [stripped]
        else:
            current.append(stripped)

    if current:
        definitions.append(" ".join(current))

    return [d for d in definitions if len(d) > 15]


def parse_definition(raw: str, rada_id: str, law_title: str, article: str = "1") -> Optional[Definition]:
    """Parse a raw definition string into structured components."""
    raw = raw.strip()
    # Remove trailing semicolon/period
    raw_clean = raw.rstrip(";").rstrip(".").strip()

    # Find the copula (dash) -- match first occurrence
    m = re.match(
        r"^(?P<definiendum>[^—–\-\n]{2,100}?)\s*[—–]\s*(?P<definiens>.+)",
        raw_clean,
        re.DOTALL,
    )
    if not m:
        # Try with hyphen-minus (some laws use it)
        m = re.match(
            r"^(?P<definiendum>[^\-\n]{2,100}?)\s+-\s+(?P<definiens>.+)",
            raw_clean,
            re.DOTALL,
        )
    if not m:
        return None

    definiendum = m.group("definiendum").strip()
    full_definiens = m.group("definiens").strip()

    # Clean definiendum
    definiendum = re.sub(r"\s+", " ", definiendum)
    definiendum = definiendum.strip("()«»\"' ")

    # Validation
    if len(definiendum) < 2 or len(definiendum) > 100:
        return None
    if len(definiendum.split()) > 8:
        return None
    # Skip if definiendum is a number or starts with digit
    if definiendum[0].isdigit():
        return None
    # Skip if definiendum contains sentence-like patterns
    if any(w in definiendum.lower() for w in ("є ", "має ", "може ", "повинен ", "здійснює ")):
        return None

    # Extract genus proximum
    genus = ""
    differentia = full_definiens
    gm = GENUS_PATTERN.match(full_definiens)
    if gm:
        genus = gm.group("genus").strip()
        differentia = full_definiens[gm.end():].strip().lstrip(",").strip()
    else:
        words = full_definiens.split()
        if words:
            start = 1 if words[0].lower() == "це" else 0
            end = min(start + 3, len(words))
            genus = " ".join(words[start:end])
            differentia = " ".join(words[end:])

    return Definition(
        rada_id=rada_id,
        law_title=law_title,
        article_number=article,
        definiendum=definiendum,
        genus_proximum=genus,
        differentia_specifica=differentia,
        full_definiens=full_definiens,
        raw_text=raw[:500],
        extraction_method="definition_block",
    )


def extract_from_articles_jsonb(articles_json: list, rada_id: str, law_title: str) -> list[Definition]:
    """Extract definitions from the articles JSONB field."""
    results = []
    if not articles_json:
        return results

    for art in articles_json:
        if not isinstance(art, dict):
            continue
        art_num = str(art.get("number", art.get("article_number", "")))
        text = art.get("text", art.get("content", ""))
        if not text:
            continue

        # Check if this article contains definitions
        is_def_article = False
        if art_num in ("1", "2", "3"):
            for pat in DEFINITION_BLOCK_PATTERNS:
                if pat.search(text[:500]):
                    is_def_article = True
                    break

        if not is_def_article:
            continue

        block = find_definition_block(text)
        if not block:
            block = text

        raw_defs = split_definitions(block)
        for raw in raw_defs:
            d = parse_definition(raw, rada_id, law_title, art_num)
            if d:
                results.append(d)

    return results


def main():
    # Connect to prod via SSH tunnel (must be set up: ssh -L 15432:localhost:5432 prod)
    # Or use direct docker exec approach
    use_tunnel = "--tunnel" in sys.argv
    use_local = "--local" in sys.argv

    if use_local:
        db_config = {
            "host": "localhost", "port": 5432,
            "user": "secondlayer", "password": "local_dev_password",
            "dbname": "secondlayer_local",
        }
        schema = "rada"
        print("Connecting to LOCAL DB...")
    elif use_tunnel:
        db_config = {
            "host": "localhost", "port": 15432,
            "user": "secondlayer", "password": os.environ["PGPASSWORD"],
            "dbname": "secondlayer_prod",
        }
        schema = "rada"
        print("Connecting to PROD DB via SSH tunnel (port 15432)...")
    else:
        print("Usage: python3 extract_definitions_prod.py [--local|--tunnel]")
        print("  --local   Use local DB (secondlayer_local)")
        print("  --tunnel  Use prod DB via SSH tunnel (run: ssh -L 15432:localhost:5432 prod)")
        sys.exit(1)

    conn = psycopg2.connect(**db_config)
    cur = conn.cursor()

    # Get all laws with definition patterns
    print("Querying legislation with definitions...")
    cur.execute(f"""
        SELECT law_number, title, full_text_plain, articles
        FROM {schema}.legislation
        WHERE full_text_plain IS NOT NULL
          AND length(full_text_plain) > 100
        ORDER BY law_number
    """)

    rows = cur.fetchall()
    print(f"Loaded {len(rows)} laws")

    all_definitions: list[Definition] = []
    laws_with_defs = 0

    for law_number, title, full_text, articles_json in tqdm(rows, desc="Extracting"):
        title = title or law_number or ""
        # Clean title
        title = re.sub(r"\s*\|.*$", "", title).strip()
        defs_found = []

        # Method 1: Extract from full_text_plain
        block = find_definition_block(full_text)
        if block:
            raw_defs = split_definitions(block)
            for raw in raw_defs:
                d = parse_definition(raw, law_number, title)
                if d:
                    defs_found.append(d)

        # Method 2: Extract from articles JSONB
        if articles_json and isinstance(articles_json, list):
            jsonb_defs = extract_from_articles_jsonb(articles_json, law_number, title)
            defs_found.extend(jsonb_defs)

        if defs_found:
            laws_with_defs += 1
            all_definitions.extend(defs_found)

    cur.close()
    conn.close()

    # Deduplicate by (rada_id, definiendum)
    seen = set()
    unique = []
    for d in all_definitions:
        key = (d.rada_id, d.definiendum.lower().strip())
        if key not in seen:
            seen.add(key)
            unique.append(d)

    output_path = "definitions.jsonl"
    with open(output_path, "w", encoding="utf-8") as f:
        for d in unique:
            f.write(json.dumps(asdict(d), ensure_ascii=False) + "\n")

    print(f"\nExtraction complete:")
    print(f"  Laws scanned: {len(rows)}")
    print(f"  Laws with definitions: {laws_with_defs}")
    print(f"  Raw definitions extracted: {len(all_definitions)}")
    print(f"  Unique definitions: {len(unique)}")
    print(f"  Output: {output_path}")

    by_law = {}
    for d in unique:
        by_law.setdefault(d.rada_id, []).append(d)
    print(f"\n  Top 15 laws by definition count:")
    for rid, defs in sorted(by_law.items(), key=lambda x: -len(x[1]))[:15]:
        t = defs[0].law_title[:60] or rid
        print(f"    {rid}: {len(defs)} defs - {t}")


if __name__ == "__main__":
    main()
