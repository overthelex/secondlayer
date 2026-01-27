# OPENREYESTR Data Sources Schema

## Overview
11 registries from NAIS (National Information Systems of Ukraine) + 2 auxiliary tables

---

## Data Sources

| # | Registry Name | Description | Format | Update Frequency | Primary Key | Estimated Size |
|---|---------------|-------------|--------|------------------|-------------|----------------|
| 1 | **legal_entities** | Єдиний державний реєстр юридичних осіб, фізичних осіб-підприємців та громадських формувань | XML | Every 5 business days | `edrpou` (10 chars) | 2-3M rows, ~50 GB |
| 2 | **notaries** | Єдиний реєстр нотаріусів | XML | Weekly | `certificate_number` (50 chars) | 5-10K rows, ~100 MB |
| 3 | **court_experts** | Державний реєстр атестованих судових експертів | XML | Within 5 business days of changes | `expert_id` (50 chars) | 10-20K rows, ~200 MB |
| 4 | **special_forms** | Єдиний реєстр спеціальних бланків нотаріальних документів | XML | Weekly | `series` + `form_number` | 100K-500K rows, ~5 GB |
| 5 | **forensic_methods** | Реєстр методик проведення судових експертиз | XML | Weekly | `registration_code` (50 chars) | 5-10K rows, ~100 MB |
| 6 | **bankruptcy_cases** | Реєстр підприємств у справах про банкрутство | XML | Daily | `registration_number` (50 chars) | 50-100K rows, ~2 GB |
| 7 | **arbitration_managers** | Єдиний реєстр арбітражних керуючих України | XML | Daily | `registration_number` (50 chars) | 5-10K rows, ~100 MB |
| 8 | **legal_acts** | Єдиний державний реєстр нормативно-правових актів | XML | Weekly | `act_id` (100 chars) | 500K-1M rows, ~20 GB |
| 9 | **administrative_units** | Словник адміністративно-територіального устрою України | XML | Weekly | `koatuu` (20 chars) | 50-100K rows, ~1 GB |
| 10 | **streets** | Словник вулиць населених пунктів | XML | Weekly | None (composite) | 500K-1M rows, ~10 GB |
| 11 | **enforcement_proceedings** | Інформація з автоматизованої системи виконавчого провадження | CSV | Daily | `proceeding_number` (100 chars) | 5-10M rows, ~100 GB |
| 12 | **debtors** | Єдиний реєстр боржників | CSV | Daily | None (composite) | 3-5M rows, ~50 GB |

**Total Estimated Storage**: 240-340 GB with full data import

---

## Detailed Schema by Data Source

### 1. Legal Entities Registry (`legal_entities`)
**Purpose**: Complete registry of legal entities, individual entrepreneurs, and public organizations

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `edrpou` | VARCHAR(10) | ЄДРПОУ code (unique identifier) | ✓ UNIQUE |
| `full_name` | TEXT | Full company name | ✓ FTS |
| `short_name` | TEXT | Short name | |
| `legal_form` | VARCHAR(255) | Organizational form (ТОВ, ПП, etc.) | |
| `status` | VARCHAR(100) | Active/inactive/liquidated | ✓ |
| `registration_date` | DATE | Registration date | |
| `termination_date` | DATE | Termination date (if applicable) | |
| `address` | TEXT | Legal address | |
| `region` | VARCHAR(255) | Administrative region | ✓ |
| `activity_type` | VARCHAR(500) | KVED activity codes | |
| `authorized_capital` | NUMERIC | Authorized capital amount | |
| `founders` | JSONB | Structured founder data | |
| `management` | JSONB | Management persons | |
| `raw_data` | JSONB | Complete XML data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source ZIP/XML filename | |

**Relationships**: Can link to `bankruptcy_cases`, `enforcement_proceedings`, `debtors` via `edrpou`

---

### 2. Notaries Registry (`notaries`)
**Purpose**: Registry of all certified notaries in Ukraine

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `certificate_number` | VARCHAR(50) | Unique certificate ID | ✓ UNIQUE |
| `full_name` | VARCHAR(255) | Notary full name | ✓ FTS |
| `region` | VARCHAR(255) | Region of operation | ✓ |
| `district` | VARCHAR(255) | District | |
| `organization` | VARCHAR(500) | Workplace/notary office | |
| `address` | TEXT | Office address | |
| `phone` | VARCHAR(50) | Contact phone | |
| `email` | VARCHAR(255) | Email address | |
| `certificate_date` | DATE | Certificate issue date | |
| `status` | VARCHAR(100) | active/suspended/terminated | ✓ |
| `raw_data` | JSONB | Complete XML data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

---

### 3. Court Experts Registry (`court_experts`)
**Purpose**: Registry of certified forensic/court experts

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `expert_id` | VARCHAR(50) | Expert identifier | ✓ UNIQUE |
| `full_name` | VARCHAR(255) | Expert full name | ✓ FTS |
| `region` | VARCHAR(255) | Region | ✓ |
| `organization` | VARCHAR(500) | Organization/institution | |
| `commission_name` | VARCHAR(500) | Attestation commission | |
| `expertise_types` | TEXT[] | Array of expertise types | ✓ GIN |
| `certificate_number` | VARCHAR(50) | Certificate number | |
| `certificate_date` | DATE | Certificate issue date | |
| `status` | VARCHAR(100) | Active status | |
| `raw_data` | JSONB | Complete XML data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

---

### 4. Special Forms Registry (`special_forms`)
**Purpose**: Registry of special notarial document forms (numbered security documents)

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `series` | VARCHAR(20) | Form series | ✓ |
| `form_number` | VARCHAR(50) | Form number | ✓ UNIQUE (with series) |
| `issue_date` | DATE | Date issued | ✓ |
| `recipient` | VARCHAR(500) | Who received the form | |
| `usage_info` | TEXT | Usage information | |
| `usage_date` | DATE | When used | |
| `document_type` | VARCHAR(255) | Type of document | |
| `status` | VARCHAR(100) | used/unused/cancelled | ✓ |
| `raw_data` | JSONB | Complete XML data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

---

### 5. Forensic Methods Registry (`forensic_methods`)
**Purpose**: Registry of approved forensic examination methodologies

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `registration_code` | VARCHAR(50) | Unique method code | ✓ UNIQUE |
| `expertise_type` | VARCHAR(500) | Type of expertise | ✓ |
| `method_name` | TEXT | Methodology name | ✓ FTS |
| `developer` | VARCHAR(500) | Organization that developed it | |
| `year_created` | INTEGER | Year of creation | ✓ |
| `registration_date` | DATE | Registration date | |
| `registration_info` | TEXT | Registration details | |
| `status` | VARCHAR(100) | Active status | |
| `raw_data` | JSONB | Complete XML data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

---

### 6. Bankruptcy Cases Registry (`bankruptcy_cases`)
**Purpose**: Registry of bankruptcy proceedings for enterprises

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `registration_number` | VARCHAR(50) | Case registration number | ✓ UNIQUE |
| `registration_date` | DATE | Date registered | ✓ |
| `case_number` | VARCHAR(100) | Court case number | |
| `court_decision_date` | DATE | Date of court decision | |
| `debtor_name` | TEXT | Debtor name | ✓ FTS |
| `debtor_edrpou` | VARCHAR(10) | Debtor ЄДРПОУ | ✓ |
| `debtor_type` | VARCHAR(50) | legal/individual | |
| `proceeding_status` | VARCHAR(255) | Current status | ✓ |
| `court_name` | VARCHAR(500) | Which court | |
| `raw_data` | JSONB | Complete XML data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

**Relationships**: Links to `legal_entities` via `debtor_edrpou`

---

### 7. Arbitration Managers Registry (`arbitration_managers`)
**Purpose**: Registry of certified bankruptcy arbitration managers

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `registration_number` | VARCHAR(50) | Registration ID | ✓ UNIQUE |
| `registration_date` | DATE | Date registered | |
| `full_name` | VARCHAR(255) | Manager name | ✓ FTS |
| `certificate_number` | VARCHAR(50) | Certificate ID | ✓ |
| `certificate_status` | VARCHAR(100) | active/suspended/revoked | ✓ |
| `certificate_issue_date` | DATE | Certificate issue date | |
| `certificate_change_date` | DATE | Last certificate change | |
| `raw_data` | JSONB | Complete XML data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

---

### 8. Legal Acts Registry (`legal_acts`)
**Purpose**: Registry of all normative legal acts (laws, decrees, orders)

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `act_id` | VARCHAR(100) | Unique act identifier | ✓ UNIQUE |
| `publisher` | VARCHAR(500) | Publishing body (ministry, etc.) | ✓ |
| `act_type` | VARCHAR(255) | Type (law, decree, order, etc.) | ✓ |
| `act_number` | VARCHAR(100) | Act number | |
| `act_date` | DATE | Act date | ✓ |
| `act_title` | TEXT | Title of the act | ✓ FTS |
| `act_text` | TEXT | Full text content | ✓ FTS |
| `registration_number` | VARCHAR(100) | Registration number | |
| `registration_date` | DATE | Registration date | |
| `status` | VARCHAR(100) | active/terminated/suspended | |
| `effective_date` | DATE | When it becomes effective | |
| `termination_date` | DATE | When terminated | |
| `raw_data` | JSONB | Complete XML data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

---

### 9. Administrative Units Dictionary (`administrative_units`)
**Purpose**: Dictionary of administrative-territorial structure of Ukraine

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `koatuu` | VARCHAR(20) | КОАТУУ code (unique identifier) | ✓ UNIQUE |
| `unit_type` | VARCHAR(50) | область/район/місто/село | ✓ |
| `region` | VARCHAR(255) | Region name | ✓ |
| `district` | VARCHAR(255) | District name | |
| `settlement_name` | VARCHAR(500) | Settlement name | ✓ FTS |
| `full_name` | TEXT | Complete name | |
| `parent_koatuu` | VARCHAR(20) | Parent unit code | |
| `raw_data` | JSONB | Complete XML data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

**Relationships**: Referenced by `streets` table via `koatuu`

---

### 10. Streets Dictionary (`streets`)
**Purpose**: Dictionary of streets in all Ukrainian settlements

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `street_id` | VARCHAR(50) | Street identifier | |
| `settlement_koatuu` | VARCHAR(20) | Link to administrative unit | ✓ FK |
| `street_type` | VARCHAR(50) | вулиця/провулок/площа | ✓ |
| `street_name` | VARCHAR(500) | Name of the street | ✓ FTS |
| `full_address` | TEXT | Complete address | |
| `region` | VARCHAR(255) | Region | ✓ |
| `district` | VARCHAR(255) | District | |
| `settlement` | VARCHAR(500) | Settlement name | |
| `raw_data` | JSONB | Complete XML data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

**Foreign Key**: `settlement_koatuu` → `administrative_units.koatuu`

---

### 11. Enforcement Proceedings (`enforcement_proceedings`)
**Purpose**: Information from automated enforcement proceedings system

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `proceeding_number` | VARCHAR(100) | Unique proceeding ID | ✓ UNIQUE |
| `opening_date` | DATE | Date opened | ✓ |
| `proceeding_status` | VARCHAR(255) | Current status | ✓ |
| `debtor_name` | TEXT | Debtor name | ✓ FTS |
| `debtor_type` | VARCHAR(50) | individual/legal | |
| `debtor_edrpou` | VARCHAR(10) | Debtor ЄДРПОУ (if legal entity) | ✓ |
| `creditor_name` | TEXT | Creditor name | |
| `creditor_type` | VARCHAR(50) | individual/legal | |
| `creditor_edrpou` | VARCHAR(10) | Creditor ЄДРПОУ | |
| `enforcement_agency` | VARCHAR(500) | Which agency | |
| `executor_name` | VARCHAR(255) | Bailiff name | |
| `raw_data` | JSONB | Complete CSV data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

**Data Format**: CSV (not XML like others)
**Relationships**: Links to `legal_entities` via `debtor_edrpou`

---

### 12. Debtors Registry (`debtors`)
**Purpose**: Unified registry of debtors

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `proceeding_number` | VARCHAR(100) | Related proceeding | ✓ |
| `debtor_name` | TEXT | Debtor name | ✓ FTS |
| `debtor_type` | VARCHAR(50) | individual/legal | ✓ |
| `debtor_edrpou` | VARCHAR(10) | Debtor ЄДРПОУ | ✓ |
| `issuing_authority` | VARCHAR(500) | Who issued | |
| `issuing_person` | VARCHAR(255) | Person who issued | |
| `enforcement_agency` | VARCHAR(500) | Enforcement details | |
| `executor_name` | VARCHAR(255) | Bailiff name | |
| `executor_phone` | VARCHAR(50) | Contact phone | |
| `executor_email` | VARCHAR(255) | Contact email | |
| `collection_category` | VARCHAR(255) | Type (alimony/fine/etc.) | ✓ |
| `raw_data` | JSONB | Complete CSV data | |
| `created_at` | TIMESTAMP | Record creation time | |
| `updated_at` | TIMESTAMP | Last update time | |
| `data_source` | VARCHAR(255) | Always "NAIS" | |
| `source_file` | VARCHAR(500) | Source filename | |

**Data Format**: CSV (not XML like others)
**Relationships**: Links to `legal_entities` via `debtor_edrpou`

---

## Auxiliary Tables

### 13. Registry Metadata (`registry_metadata`)
**Purpose**: Metadata about each of the 11 registries

| Field | Type | Description |
|-------|------|-------------|
| `id` | SERIAL | Primary key |
| `registry_id` | INTEGER | Registry number (1-11) UNIQUE |
| `registry_name` | VARCHAR(255) | Table name |
| `registry_title` | TEXT | Ukrainian title |
| `description` | TEXT | Description |
| `data_format` | VARCHAR(50) | XML or CSV |
| `update_frequency` | VARCHAR(100) | How often updated |
| `last_update_date` | DATE | Last known update |
| `official_url` | TEXT | NAIS page URL |
| `dataset_url` | TEXT | Download link |
| `schema_url` | TEXT | Schema documentation |
| `active` | BOOLEAN | Is registry active |
| `created_at` | TIMESTAMP | Record creation time |
| `updated_at` | TIMESTAMP | Last update time |

**Pre-populated**: Contains metadata for all 11 registries

---

### 14. Import Log (`import_log`)
**Purpose**: Track data import operations

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `id` | UUID | Primary key | ✓ |
| `registry_name` | VARCHAR(255) | Which registry | ✓ |
| `registry_id` | INTEGER | Registry number | |
| `file_name` | VARCHAR(500) | Source file | |
| `file_url` | TEXT | Source URL | |
| `file_date` | DATE | Date of the data file | |
| `import_started_at` | TIMESTAMP | Import start time | ✓ |
| `import_completed_at` | TIMESTAMP | Import end time | |
| `records_imported` | INTEGER | Success count | |
| `records_failed` | INTEGER | Failure count | |
| `status` | VARCHAR(50) | in_progress/completed/failed | ✓ |
| `error_message` | TEXT | Error details | |
| `metadata` | JSONB | Additional import info | |

---

## Common Features

### All Tables Include:
- **UUID Primary Keys**: Better for distributed systems
- **JSONB `raw_data`**: Preserves complete original XML/CSV
- **Timestamps**: `created_at`, `updated_at` (auto-updated via trigger)
- **Data Source Tracking**: `data_source`, `source_file`
- **Full-Text Search**: GIN indexes on Ukrainian text fields

### Index Types:
- **B-tree**: Standard indexes on VARCHAR/DATE fields
- **GIN**: Full-text search (`to_tsvector('ukrainian', field)`)
- **GIN**: Array fields (e.g., `expertise_types`)

### Automatic Triggers:
All tables have `BEFORE UPDATE` triggers that automatically update `updated_at` timestamp

---

## Data Relationships

```
legal_entities (edrpou)
    ├── bankruptcy_cases (debtor_edrpou) [logical]
    ├── enforcement_proceedings (debtor_edrpou) [logical]
    └── debtors (debtor_edrpou) [logical]

administrative_units (koatuu)
    └── streets (settlement_koatuu) [FK constraint]

enforcement_proceedings (proceeding_number)
    └── debtors (proceeding_number) [logical]
```

**Note**: Only `streets` → `administrative_units` has a formal FOREIGN KEY constraint. Other relationships are logical (can be joined but no FK constraint).

---

## Query Performance Tips

1. **Use full-text search** for name queries:
   ```sql
   WHERE to_tsvector('ukrainian', full_name) @@ to_tsquery('ukrainian', 'search_term')
   ```

2. **Index coverage**: All common search fields are indexed
3. **JSONB queries**: Use `->`, `->>`, `@>` operators for `raw_data`
4. **Partitioning**: Consider partitioning large tables (legal_entities, enforcement_proceedings) by region or date for better performance

---

## Official Data Sources

All data from: https://nais.gov.ua/pass_opendata

**Data Provider**: ДП "Національні інформаційні системи" (National Information Systems)
**Data License**: Open Data (публічна інформація)
