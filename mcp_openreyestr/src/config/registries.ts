/**
 * NAIS Registry Configuration
 * Single source of truth for all 11 NAIS registries from data.gov.ua
 */

export type FieldMapper = (value: string, record: Record<string, unknown>) => unknown;

export interface RegistryConfig {
  id: number;
  name: string;
  title: string;
  format: 'xml' | 'csv';
  encoding: string;
  datasetUrl: string;
  zipFileName: string;
  /** Expected file inside the ZIP (xml or csv). If empty, auto-detect by extension. */
  innerFileName: string;
  tableName: string;
  /** Column(s) for ON CONFLICT. Array = composite unique. */
  uniqueKey: string | string[];
  /** XML root path to records, e.g. "DATA.RECORD" */
  recordPath: string;
  /** Map: DB column name → XML/CSV field name (string) or custom mapper */
  fieldMap: Record<string, string | FieldMapper>;
  /** Columns to insert (derived from fieldMap keys at runtime) */
  updateFrequency: 'daily' | 'weekly';
  /** Approximate size category for choosing parser strategy */
  sizeCategory: 'small' | 'medium' | 'large' | 'huge';
  /** CSV-specific: delimiter character */
  csvDelimiter?: string;
  /** CSV-specific: header row field names (if CSV has no header) */
  csvHeaders?: string[];
}

// Helper: extract nested value from object by dot path
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Extract text value from EDRNPA item-based XML structure.
 * Records look like: { item: [{ "@_name": "publisher", text: "..." }, ...] }
 */
/** Convert dd.mm.yyyy or dd.mm.yyyy HH:MM:SS to yyyy-mm-dd for PostgreSQL */
function parseDateDMY(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const match = dateStr.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function extractItemText(record: Record<string, unknown>, itemName: string): string | null {
  const items = record['item'];
  if (!items) return null;
  const arr = Array.isArray(items) ? items : [items];
  const found = arr.find((it: any) => it['@_name'] === itemName);
  if (!found) return null;
  const text = found['text'];
  if (text == null) return null;
  // text can be a string or { text: [...] } (textlist)
  if (typeof text === 'string') return text.trim();
  if (typeof text === 'object' && text['#text']) return String(text['#text']).trim();
  return String(text).trim() || null;
}

export const REGISTRIES: Record<string, RegistryConfig> = {
  notaries: {
    id: 2,
    name: 'notaries',
    title: 'Єдиний реєстр нотаріусів',
    format: 'xml',
    encoding: 'windows-1251',
    datasetUrl: 'https://data.gov.ua/dataset/85a68e3e-8cb0-41b8-a764-58d005063b52/resource/65e9ad78-0e65-4672-ba42-f7613e0fa493/download/17-ex_xml_wern.zip',
    zipFileName: '17-ex_xml_wern.zip',
    innerFileName: '17-ex_xml_wern.xml',
    tableName: 'notaries',
    uniqueKey: 'certificate_number',
    recordPath: 'DATA.RECORD',
    fieldMap: {
      certificate_number: 'LICENSE',
      full_name: 'FIO',
      region: 'REGION',
      organization: 'NAME_OBJ',
      address: 'CONTACTS',
      status: () => 'active',
    },
    updateFrequency: 'weekly',
    sizeCategory: 'small',
  },

  court_experts: {
    id: 3,
    name: 'court_experts',
    title: 'Державний реєстр атестованих судових експертів',
    format: 'xml',
    encoding: 'windows-1251',
    datasetUrl: 'https://data.gov.ua/dataset/f615eb1d-cda0-411e-800b-efb61fb9fb46/resource/c89d0270-c87a-4781-a96b-41def560c6fc/download/18-ex_xml_expert.zip',
    zipFileName: '18-ex_xml_expert.zip',
    innerFileName: '18-ex_xml_expert.xml',
    tableName: 'court_experts',
    uniqueKey: 'expert_id',
    recordPath: 'DATA.RECORD',
    fieldMap: {
      expert_id: 'LICENSE',
      full_name: (_v: string, r: Record<string, unknown>) => {
        const surname = String(r['SURNAME'] || '');
        const names = Array.isArray(r['NAME']) ? r['NAME'] : [r['NAME'] || ''];
        return `${surname} ${names[0] || ''} ${names[1] || ''}`.trim();
      },
      region: 'REGION_NAME',
      organization: 'ORG_NAME',
      status: () => 'active',
    },
    updateFrequency: 'weekly',
    sizeCategory: 'small',
  },

  arbitration_managers: {
    id: 7,
    name: 'arbitration_managers',
    title: 'Єдиний реєстр арбітражних керуючих України',
    format: 'xml',
    encoding: 'windows-1251',
    datasetUrl: 'https://data.gov.ua/dataset/d7cca6b1-863c-4c7d-a90b-6d024a68a4f7/resource/60439f25-5162-4e7a-b59d-cf9224346159/download/25-ex_xml_arbker.zip',
    zipFileName: '25-ex_xml_arbker.zip',
    innerFileName: '25-ex_xml_arbker.xml',
    tableName: 'arbitration_managers',
    uniqueKey: 'registration_number',
    recordPath: 'DATA.RECORD',
    fieldMap: {
      registration_number: 'REG_NUM',
      registration_date: 'REG_DATE',
      full_name: 'AK_NAME',
      certificate_number: 'CERT_NUMB',
      certificate_status: 'CERT_STATUS',
      certificate_issue_date: 'CERT_DATE_ISSUE',
      certificate_change_date: 'CERT_DATE_CHANGE',
    },
    updateFrequency: 'daily',
    sizeCategory: 'small',
  },

  special_forms: {
    id: 4,
    name: 'special_forms',
    title: 'Єдиний реєстр спеціальних бланків нотаріальних документів',
    format: 'xml',
    encoding: 'windows-1251',
    datasetUrl: 'https://data.gov.ua/dataset/cadd1d81-5db8-4767-9730-fb58e33260df/resource/b5b5c9f7-1548-4566-879d-b777dcbaca7b/download/19-ex_xml_ernb_29-12-2025-09-02-2026.zip',
    zipFileName: '19-ex_xml_ernb.zip',
    innerFileName: '',
    tableName: 'special_forms',
    uniqueKey: ['series', 'form_number'],
    recordPath: 'DATA.RECORD',
    fieldMap: {
      series: 'SERIES',
      form_number: 'NUMBER',
      issue_date: 'DATE_ISSUE',
      recipient: 'RECIPIENT',
      usage_info: 'USAGE_INFO',
      usage_date: 'DATE_USAGE',
      document_type: 'DOC_TYPE',
      status: 'STATUS',
    },
    updateFrequency: 'weekly',
    sizeCategory: 'large',
  },

  forensic_methods: {
    id: 5,
    name: 'forensic_methods',
    title: 'Реєстр методик проведення судових експертиз',
    format: 'xml',
    encoding: 'windows-1251',
    datasetUrl: 'https://data.gov.ua/dataset/7a990ce7-d07d-4a44-a1e5-db9166577778/resource/7d728d1a-afa4-452f-9bfc-f3dcc46ac91d/download/22-ex_xml_methodics.zip',
    zipFileName: '22-ex_xml_methodics.zip',
    innerFileName: '22-ex_xml_methodics.xml',
    tableName: 'forensic_methods',
    uniqueKey: 'registration_code',
    recordPath: 'DATA.RECORD',
    fieldMap: {
      registration_code: 'REG_CODE',
      expertise_type: 'EXP_TYPE',
      method_name: 'METHOD_NAME',
      developer: 'DEVELOPER',
      year_created: 'YEAR_CREATED',
      registration_date: 'REG_DATE',
      registration_info: 'REG_INFO',
      status: 'STATUS',
    },
    updateFrequency: 'weekly',
    sizeCategory: 'small',
  },

  bankruptcy_cases: {
    id: 6,
    name: 'bankruptcy_cases',
    title: 'Реєстр підприємств у справах про банкрутство',
    format: 'xml',
    encoding: 'windows-1251',
    datasetUrl: 'https://data.gov.ua/dataset/46536adb-45ac-479c-8ede-13e61606d1bb/resource/ac8bc0de-6d40-43d7-a898-c7c7773d6b99/download/23-ex_xml_rba.zip',
    zipFileName: '23-ex_xml_rba.zip',
    innerFileName: '23-ex_xml_rba.xml',
    tableName: 'bankruptcy_cases',
    uniqueKey: 'registration_number',
    recordPath: 'DATA.RECORD',
    fieldMap: {
      registration_number: 'REG_NUM',
      registration_date: 'REG_DATE',
      case_number: 'CASE_NUM',
      court_decision_date: 'COURT_DATE',
      debtor_name: 'DEBTOR_NAME',
      debtor_edrpou: 'DEBTOR_EDRPOU',
      debtor_type: 'DEBTOR_TYPE',
      proceeding_status: 'STATUS',
      court_name: 'COURT_NAME',
    },
    updateFrequency: 'daily',
    sizeCategory: 'medium',
  },

  legal_acts: {
    id: 8,
    name: 'legal_acts',
    title: 'Єдиний державний реєстр нормативно-правових актів',
    format: 'xml',
    encoding: 'utf-8',
    datasetUrl: 'https://data.gov.ua/dataset/b22d184c-4826-4e1d-8577-972effc5700c/resource/5616dd04-949a-489c-8efc-54004293b238/download/25-edrnpa.zip',
    zipFileName: '25-edrnpa.zip',
    innerFileName: 'edrnpa_cards',
    tableName: 'legal_acts',
    uniqueKey: 'act_id',
    recordPath: 'rna.database.document',
    fieldMap: {
      act_id: (_v: string, r: Record<string, unknown>) => {
        // Build unique ID from reestr_code or number+date
        const code = extractItemText(r, 'reestr_code');
        if (code) return code;
        const num = extractItemText(r, 'number');
        const date = extractItemText(r, 'date_acc');
        return `${num || 'unknown'}_${date || 'unknown'}`;
      },
      publisher: (_v: string, r: Record<string, unknown>) => extractItemText(r, 'publisher'),
      act_type: (_v: string, r: Record<string, unknown>) => extractItemText(r, 'type'),
      act_number: (_v: string, r: Record<string, unknown>) => extractItemText(r, 'number'),
      act_date: (_v: string, r: Record<string, unknown>) => parseDateDMY(extractItemText(r, 'date_acc')),
      act_title: (_v: string, r: Record<string, unknown>) => extractItemText(r, 'name'),
      act_text: () => null, // Text is in separate file
      registration_number: (_v: string, r: Record<string, unknown>) => extractItemText(r, 'reestr_code'),
      registration_date: (_v: string, r: Record<string, unknown>) => parseDateDMY(extractItemText(r, 'reestr_date')),
      status: (_v: string, r: Record<string, unknown>) => extractItemText(r, 'status'),
      effective_date: () => null,
      termination_date: () => null,
    },
    updateFrequency: 'weekly',
    sizeCategory: 'medium',
  },

  administrative_units: {
    id: 9,
    name: 'administrative_units',
    title: 'Словник адміністративно-територіального устрою України',
    format: 'xml',
    encoding: 'windows-1251',
    datasetUrl: 'https://data.gov.ua/dataset/75e57837-128b-49e1-a007-5e7dfa7bf6af/resource/ebf7c760-403e-4166-b96f-715585bce1a4/download/26-ex_xml_atu.zip',
    zipFileName: '26-ex_xml_atu.zip',
    innerFileName: '26-ex_xml_atu.xml',
    tableName: 'administrative_units',
    uniqueKey: 'koatuu',
    recordPath: 'DATA.RECORD',
    fieldMap: {
      koatuu: 'KOATUU',
      unit_type: 'UNIT_TYPE',
      region: 'REGION',
      district: 'DISTRICT',
      settlement_name: 'SETTLEMENT',
      full_name: 'FULL_NAME',
      parent_koatuu: 'PARENT_KOATUU',
    },
    updateFrequency: 'weekly',
    sizeCategory: 'large',
  },

  streets: {
    id: 10,
    name: 'streets',
    title: 'Словник вулиць населених пунктів',
    format: 'xml',
    encoding: 'windows-1251',
    datasetUrl: 'https://data.gov.ua/dataset/75e57837-128b-49e1-a007-5e7dfa7bf6af/resource/e21a1e57-051c-46ea-9c8e-8f30de7d863d/download/28-ex_xml_atu.zip',
    zipFileName: '28-ex_xml_streets.zip',
    innerFileName: '',
    tableName: 'streets',
    uniqueKey: ['settlement_koatuu', 'street_name', 'street_type'],
    recordPath: 'DATA.RECORD',
    fieldMap: {
      street_id: 'STREET_ID',
      settlement_koatuu: 'KOATUU',
      street_type: 'STREET_TYPE',
      street_name: 'STREET_NAME',
      full_address: 'FULL_ADDRESS',
      region: 'REGION',
      district: 'DISTRICT',
      settlement: 'SETTLEMENT',
    },
    updateFrequency: 'weekly',
    sizeCategory: 'large',
  },

  enforcement_proceedings: {
    id: 11,
    name: 'enforcement_proceedings',
    title: 'Інформація з автоматизованої системи виконавчого провадження',
    format: 'csv',
    encoding: 'windows-1251',
    datasetUrl: 'https://data.gov.ua/dataset/22aef563-3e87-4ed9-92e8-d764dc02f426/resource/d1a38c08-0f3a-4687-866f-f28f50df7c46/download/28-ex_csv_asvp.zip',
    zipFileName: '28-ex_csv_asvp.zip',
    innerFileName: '',
    tableName: 'enforcement_proceedings',
    uniqueKey: 'proceeding_number',
    recordPath: '',
    fieldMap: {
      proceeding_number: 'VP_ORDERNUM',
      opening_date: (_v: string, r: Record<string, unknown>) => parseDateDMY(String(r['VP_BEGINDATE'] || '')),
      proceeding_status: 'VP_STATE',
      debtor_name: 'DEBTOR_NAME',
      debtor_type: (_v: string, r: Record<string, unknown>) => {
        const code = String(r['DEBTOR_CODE'] || '');
        return code.length === 8 ? 'legal' : 'individual';
      },
      debtor_edrpou: 'DEBTOR_CODE',
      creditor_name: 'CREDITOR_NAME',
      creditor_type: (_v: string, r: Record<string, unknown>) => {
        const code = String(r['CREDITOR_CODE'] || '');
        return code.length === 8 ? 'legal' : 'individual';
      },
      creditor_edrpou: 'CREDITOR_CODE',
      enforcement_agency: 'ORG_NAME',
      executor_name: 'EXECUTOR_NAME',
    },
    updateFrequency: 'daily',
    sizeCategory: 'huge',
    csvDelimiter: ',',
  },

  debtors: {
    id: 12,
    name: 'debtors',
    title: 'Єдиний реєстр боржників',
    format: 'csv',
    encoding: 'windows-1251',
    datasetUrl: 'https://data.gov.ua/dataset/783b9b50-faba-4cc9-a393-60485e395b1d/resource/e6ea76c1-01f4-4bd0-a282-7d92d6ecc2a1/download/29-ex_csv_erb.zip',
    zipFileName: '29-ex_csv_erb.zip',
    innerFileName: '',
    tableName: 'debtors',
    uniqueKey: ['proceeding_number', 'debtor_name', 'debtor_edrpou'],
    recordPath: '',
    fieldMap: {
      proceeding_number: 'VP_ORDERNUM',
      debtor_name: 'DEBTOR_NAME',
      debtor_type: (_v: string, r: Record<string, unknown>) => {
        // No explicit type field — infer from DEBTOR_CODE length
        const code = String(r['DEBTOR_CODE'] || '');
        return code.length === 8 ? 'legal' : 'individual';
      },
      debtor_edrpou: 'DEBTOR_CODE',
      issuing_authority: 'PUBLISHER',
      issuing_person: 'EMP_FULL_FIO',
      enforcement_agency: 'ORG_NAME',
      executor_name: 'EMP_FULL_FIO',
      executor_phone: 'EMP_PHONE_NUM',
      executor_email: 'EMAIL_ADDR',
      collection_category: 'VD_CAT',
    },
    updateFrequency: 'daily',
    sizeCategory: 'huge',
    csvDelimiter: ',',
    /** Note: header uses ';' but data rows use ',' — the CSV importer must handle this */
  },
};

/** Get registry configs filtered by format */
export function getXmlRegistries(): RegistryConfig[] {
  return Object.values(REGISTRIES).filter(r => r.format === 'xml');
}

export function getCsvRegistries(): RegistryConfig[] {
  return Object.values(REGISTRIES).filter(r => r.format === 'csv');
}

/** Get registries that need streaming parser (large/huge) */
export function getStreamingRegistries(): RegistryConfig[] {
  return Object.values(REGISTRIES).filter(r => r.sizeCategory === 'large' || r.sizeCategory === 'huge');
}
