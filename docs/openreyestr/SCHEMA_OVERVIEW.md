# Database Schema Overview

## Tables Summary

### 1. Legal Entities Registry (`legal_entities`)
**Purpose**: Єдиний державний реєстр юридичних осіб, ФОП та громадських формувань

**Key Fields**:
- `edrpou` - ЄДРПОУ код (unique identifier)
- `full_name`, `short_name` - Company names
- `legal_form` - Organizational form
- `status` - Active/inactive status
- `registration_date` - Date of registration
- `address`, `region` - Location
- `founders` (JSONB) - Founder information
- `management` (JSONB) - Management structure

**Indexes**: edrpou, status, region, full-text search on name

---

### 2. Notaries Registry (`notaries`)
**Purpose**: Єдиний реєстр нотаріусів

**Key Fields**:
- `certificate_number` - Unique certificate ID
- `full_name` - Notary name
- `region`, `district` - Location
- `organization` - Workplace
- `address`, `phone`, `email` - Contact info
- `certificate_date` - Certificate issue date
- `status` - Active/suspended/terminated

**Indexes**: certificate_number, region, status, full-text search

---

### 3. Court Experts Registry (`court_experts`)
**Purpose**: Державний реєстр атестованих судових експертів

**Key Fields**:
- `expert_id` - Expert identifier
- `full_name` - Expert name
- `region`, `organization` - Location
- `commission_name` - Attestation commission
- `expertise_types` (array) - Types of expertise
- `certificate_number`, `certificate_date` - Certification info
- `status` - Active status

**Indexes**: expert_id, region, expertise types (GIN), full-text search

---

### 4. Special Forms Registry (`special_forms`)
**Purpose**: Єдиний реєстр спеціальних бланків нотаріальних документів

**Key Fields**:
- `series`, `form_number` - Form identification
- `issue_date` - Date of issue
- `recipient` - Who received the form
- `usage_info`, `usage_date` - Usage information
- `document_type` - Type of document
- `status` - Used/unused status

**Indexes**: series, form_number, issue_date, status

---

### 5. Forensic Methods Registry (`forensic_methods`)
**Purpose**: Реєстр методик проведення судових експертиз

**Key Fields**:
- `registration_code` - Unique method code
- `expertise_type` - Type of expertise
- `method_name` - Name of the methodology
- `developer` - Organization that developed it
- `year_created` - Year of creation
- `registration_date`, `registration_info` - Registration details

**Indexes**: registration_code, expertise_type, year, full-text search

---

### 6. Bankruptcy Cases Registry (`bankruptcy_cases`)
**Purpose**: Реєстр підприємств у справах про банкрутство

**Key Fields**:
- `registration_number` - Case registration number
- `registration_date` - Date registered
- `case_number` - Court case number
- `court_decision_date` - Date of court decision
- `debtor_name`, `debtor_edrpou` - Debtor information
- `debtor_type` - Legal entity or individual
- `proceeding_status` - Current status
- `court_name` - Which court

**Indexes**: registration_number, edrpou, status, date, full-text search

---

### 7. Arbitration Managers Registry (`arbitration_managers`)
**Purpose**: Реєстр арбітражних керуючих України

**Key Fields**:
- `registration_number` - Registration ID
- `registration_date` - Date registered
- `full_name` - Manager name
- `certificate_number` - Certificate ID
- `certificate_status` - Active/suspended
- `certificate_issue_date`, `certificate_change_date` - Certificate dates

**Indexes**: registration_number, certificate_number, status, full-text search

---

### 8. Legal Acts Registry (`legal_acts`)
**Purpose**: Єдиний державний реєстр нормативно-правових актів

**Key Fields**:
- `act_id` - Unique act identifier
- `publisher` - Who published (ministry, agency, etc.)
- `act_type` - Type (law, decree, order, etc.)
- `act_number`, `act_date` - Act identification
- `act_title` - Title of the act
- `act_text` - Full text content
- `registration_number`, `registration_date` - Registration info
- `status`, `effective_date`, `termination_date` - Validity info

**Indexes**: act_id, type, date, publisher, full-text search on title and text

---

### 9. Administrative Dictionary (`administrative_units`)
**Purpose**: Словник адміністративно-територіального устрою України

**Key Fields**:
- `koatuu` - КОАТУУ code (unique identifier)
- `unit_type` - Region, district, city, village
- `region`, `district`, `settlement_name` - Location hierarchy
- `full_name` - Complete name
- `parent_koatuu` - Parent unit code

**Indexes**: koatuu, unit_type, region, full-text search

---

### 10. Streets Registry (`streets`)
**Purpose**: Словник вулиць населених пунктів

**Key Fields**:
- `street_id` - Street identifier
- `settlement_koatuu` - Link to administrative unit
- `street_type` - Street, lane, square, etc.
- `street_name` - Name of the street
- `full_address` - Complete address
- `region`, `district`, `settlement` - Location

**Foreign Key**: `settlement_koatuu` → `administrative_units.koatuu`

**Indexes**: koatuu, street_type, region, full-text search

---

### 11. Enforcement Proceedings (`enforcement_proceedings`)
**Purpose**: Інформація з системи виконавчого провадження

**Key Fields**:
- `proceeding_number` - Unique proceeding ID
- `opening_date` - Date opened
- `proceeding_status` - Current status
- `debtor_name`, `debtor_edrpou`, `debtor_type` - Debtor info
- `creditor_name`, `creditor_edrpou`, `creditor_type` - Creditor info
- `enforcement_agency` - Which agency
- `executor_name` - Bailiff name

**Data Format**: CSV

**Indexes**: proceeding_number, status, debtor_edrpou, date, full-text search

---

### 12. Debtors Registry (`debtors`)
**Purpose**: Єдиний реєстр боржників

**Key Fields**:
- `proceeding_number` - Related proceeding
- `debtor_name`, `debtor_edrpou`, `debtor_type` - Debtor details
- `issuing_authority`, `issuing_person` - Who issued
- `enforcement_agency`, `executor_name` - Enforcement details
- `executor_phone`, `executor_email` - Contact info
- `collection_category` - Type (alimony, fine, etc.)

**Data Format**: CSV

**Indexes**: proceeding_number, edrpou, debtor_type, category, full-text search

---

### 13. Registry Metadata (`registry_metadata`)
**Purpose**: Metadata about each registry

**Key Fields**:
- `registry_id` - Registry number (1-11)
- `registry_name` - Table name
- `registry_title` - Ukrainian title
- `description` - Description
- `data_format` - XML or CSV
- `update_frequency` - How often updated
- `last_update_date` - Last known update
- `official_url` - NAIS page URL
- `dataset_url`, `schema_url` - Download links
- `active` - Is registry active

**Pre-populated**: Contains metadata for all 11 registries

---

### 14. Import Log (`import_log`)
**Purpose**: Track data import operations

**Key Fields**:
- `registry_name` - Which registry
- `registry_id` - Registry number
- `file_name`, `file_url` - Source file
- `file_date` - Date of the data file
- `import_started_at`, `import_completed_at` - Import timing
- `records_imported`, `records_failed` - Import statistics
- `status` - in_progress, completed, failed
- `error_message` - Error details if failed
- `metadata` (JSONB) - Additional import info

---

## Common Features Across All Tables

### UUID Primary Keys
All tables use UUID v4 as primary keys for:
- Better distribution in sharded databases
- No sequential ID information leakage
- Suitable for distributed systems

### JSONB Raw Data
All tables include a `raw_data` JSONB column that stores:
- Complete original XML or CSV data
- Allows querying nested structures
- Preserves all information even if not in structured columns

### Timestamps
- `created_at` - When record was first inserted
- `updated_at` - When record was last modified (auto-updated via trigger)

### Data Source Tracking
- `data_source` - Always "NAIS" for this project
- `source_file` - Name of the ZIP/XML/CSV file the data came from

### Full-Text Search
All text fields have GIN indexes for Ukrainian full-text search:
```sql
CREATE INDEX idx_tablename_fieldname ON tablename
USING gin(to_tsvector('ukrainian', fieldname));
```

### Automatic Update Triggers
All tables have triggers that automatically update `updated_at`:
```sql
CREATE TRIGGER update_tablename_updated_at
BEFORE UPDATE ON tablename
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

## Relationships

### Foreign Keys
- `streets.settlement_koatuu` → `administrative_units.koatuu`

### Logical Relationships (no FK constraints)
- `enforcement_proceedings.debtor_edrpou` can join with `legal_entities.edrpou`
- `bankruptcy_cases.debtor_edrpou` can join with `legal_entities.edrpou`
- `debtors.debtor_edrpou` can join with `legal_entities.edrpou`

## Size Estimates

| Table | Estimated Rows | Estimated Size |
|-------|---------------|----------------|
| legal_entities | 2-3M | 50 GB |
| notaries | 5-10K | 100 MB |
| court_experts | 10-20K | 200 MB |
| special_forms | 100K-500K | 5 GB |
| forensic_methods | 5-10K | 100 MB |
| bankruptcy_cases | 50-100K | 2 GB |
| arbitration_managers | 5-10K | 100 MB |
| legal_acts | 500K-1M | 20 GB |
| administrative_units | 50-100K | 1 GB |
| streets | 500K-1M | 10 GB |
| enforcement_proceedings | 5-10M | 100 GB |
| debtors | 3-5M | 50 GB |

**Total**: ~240-340 GB with all data imported

## Query Examples

### Search companies by name
```sql
SELECT edrpou, full_name, status, region
FROM legal_entities
WHERE to_tsvector('ukrainian', full_name) @@ to_tsquery('ukrainian', 'київстар')
ORDER BY created_at DESC;
```

### Find active notaries in Kyiv
```sql
SELECT full_name, organization, phone, email
FROM notaries
WHERE region = 'м. Київ' AND status = 'active'
ORDER BY full_name;
```

### Get bankruptcy cases for a company
```sql
SELECT bc.*
FROM bankruptcy_cases bc
JOIN legal_entities le ON bc.debtor_edrpou = le.edrpou
WHERE le.full_name ILIKE '%приватбанк%'
ORDER BY bc.registration_date DESC;
```

### Search legal acts by keyword
```sql
SELECT act_type, act_number, act_date, act_title
FROM legal_acts
WHERE to_tsvector('ukrainian', act_title || ' ' || COALESCE(act_text, ''))
      @@ to_tsquery('ukrainian', 'податок & прибуток')
ORDER BY act_date DESC
LIMIT 10;
```

### Find streets in a city
```sql
SELECT s.street_type, s.street_name, s.full_address
FROM streets s
JOIN administrative_units au ON s.settlement_koatuu = au.koatuu
WHERE au.settlement_name = 'Київ'
  AND s.street_name ILIKE 'хрещатик%'
ORDER BY s.street_name;
```
