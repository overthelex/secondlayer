/**
 * Zakononline API Domain Configuration
 *
 * Zakononline provides 5 distinct API domains:
 * 1. Court Decisions - Судові рішення
 * 2. Court Sessions - Судові засідання
 * 3. Legal Acts - Нормативно-правові акти
 * 4. Court Practice - Судова практика
 * 5. ECHR Practice - Практика ЄСПЛ
 *
 * Each domain has its own base URL, endpoints, available search targets,
 * and date fields for filtering.
 */

export type ZakonOnlineDomainName =
  | 'court_decisions'
  | 'court_sessions'
  | 'legal_acts'
  | 'court_practice'
  | 'echr_practice';

export type SearchTarget =
  | 'text'           // Full text search
  | 'title'          // Case number and title
  | 'cause_num'      // Case number only
  | 'case_involved'; // Parties/involved persons

export type SearchMode =
  | 'sph04'          // Default Sphinx search mode
  | 'extended'       // Extended query syntax (if supported)
  | 'boolean';       // Boolean operators (if supported)

export interface DomainDateFields {
  publication?: string;     // e.g., 'date_publ'
  adjudication?: string;    // e.g., 'adjudication_date'
  receipt?: string;         // e.g., 'receipt_date'
  session?: string;         // e.g., 'date_session'
  version?: string;         // e.g., 'version_date'
}

export interface DomainConfig {
  name: ZakonOnlineDomainName;
  displayName: string;
  baseURL: string;
  endpoints: {
    search: string;
    meta: string;
    dictionaries: {
      [key: string]: string;
    };
  };
  availableTargets: SearchTarget[];
  defaultTarget: SearchTarget;
  dateFields: DomainDateFields;
  defaultSortField?: string;
}

/**
 * Configuration for all Zakononline API domains
 */
export const ZAKONONLINE_DOMAINS: Record<ZakonOnlineDomainName, DomainConfig> = {
  court_decisions: {
    name: 'court_decisions',
    displayName: 'Судові рішення',
    baseURL: 'https://court.searcher.api.zakononline.com.ua',
    endpoints: {
      search: '/v1/search',
      meta: '/v1/search/meta',
      dictionaries: {
        courts: '/v1/courts',
        instances: '/v1/instances',
        judgmentForms: '/v1/judgment_forms',
        justiceKinds: '/v1/justice_kinds',
        regions: '/v1/regions',
        judges: '/v1/judges',
      },
    },
    availableTargets: ['text', 'title'],
    defaultTarget: 'text',
    dateFields: {
      publication: 'date_publ',
      adjudication: 'adjudication_date',
      receipt: 'receipt_date',
    },
    defaultSortField: 'receipt_date',
  },

  court_sessions: {
    name: 'court_sessions',
    displayName: 'Судові засідання',
    baseURL: 'https://court.searcher.api.zakononline.com.ua',
    endpoints: {
      search: '/v1/court_sessions/search',
      meta: '/v1/court_sessions/search/meta',
      dictionaries: {
        courts: '/v1/court_session_court',
        justiceKinds: '/v1/justice_kinds',
      },
    },
    availableTargets: ['cause_num', 'case_involved'],
    defaultTarget: 'case_involved',
    dateFields: {
      session: 'date_session',
    },
    defaultSortField: 'date_session',
  },

  legal_acts: {
    name: 'legal_acts',
    displayName: 'Нормативно-правові акти',
    baseURL: 'https://searcher.api.zakononline.com.ua',
    endpoints: {
      search: '/v1/search',
      meta: '/v1/search/meta',
      dictionaries: {
        documentTypes: '/v1/document_types',
        authors: '/v1/authors',
      },
    },
    availableTargets: ['title', 'text'],
    defaultTarget: 'title',
    dateFields: {
      version: 'version_date',
    },
    defaultSortField: 'version_date',
  },

  court_practice: {
    name: 'court_practice',
    displayName: 'Судова практика',
    baseURL: 'https://courtpractice.searcher.api.zakononline.com.ua',
    endpoints: {
      search: '/v1/search',
      meta: '/v1/search/meta',
      dictionaries: {
        categories: '/v1/categories',
        types: '/v1/types',
      },
    },
    availableTargets: ['text'],
    defaultTarget: 'text',
    dateFields: {
      publication: 'date_publ',
    },
    defaultSortField: 'date_publ',
  },

  echr_practice: {
    name: 'echr_practice',
    displayName: 'Практика ЄСПЛ',
    baseURL: 'https://echrpractice.searcher.api.zakononline.com.ua',
    endpoints: {
      search: '/v1/search',
      meta: '/v1/search/meta',
      dictionaries: {
        types: '/v1/types',
      },
    },
    availableTargets: ['text'],
    defaultTarget: 'text',
    dateFields: {
      publication: 'date_publ',
    },
    defaultSortField: 'date_publ',
  },
};

/**
 * Get domain configuration by name
 */
export function getDomainConfig(domain: ZakonOnlineDomainName): DomainConfig {
  return ZAKONONLINE_DOMAINS[domain];
}

/**
 * Validate if a search target is available for a domain
 */
export function isValidTarget(
  domain: ZakonOnlineDomainName,
  target: SearchTarget
): boolean {
  const config = getDomainConfig(domain);
  return config.availableTargets.includes(target);
}

/**
 * Get available date fields for a domain
 */
export function getAvailableDateFields(
  domain: ZakonOnlineDomainName
): DomainDateFields {
  return getDomainConfig(domain).dateFields;
}

/**
 * Get date field name for a specific date type in a domain
 */
export function getDateFieldName(
  domain: ZakonOnlineDomainName,
  dateType: keyof DomainDateFields
): string | undefined {
  const config = getDomainConfig(domain);
  return config.dateFields[dateType];
}
