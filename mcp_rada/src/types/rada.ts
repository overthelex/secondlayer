/**
 * RADA-specific types for data.rada.gov.ua and zakon.rada.gov.ua APIs
 */

// Known law aliases mapping
export const KNOWN_LAWS: Record<string, string> = {
  'constitution': '254к/96-вр',
  'конституція': '254к/96-вр',
  'цивільний кодекс': '435-15',
  'кримінальний кодекс': '2341-14',
  'сімейний кодекс': '2947-14',
  'господарський кодекс': '436-15',
  'кпк': '4651-17',
  'цпк': '1618-15',
  'касу': '2755-17', // Кодекс адміністративного судочинства України
  'кзпп': '1023-12', // Кодекс законів про працю
};

// data.rada.gov.ua API types

export interface RadaDeputyRawData {
  id: string;
  full_name: string;
  short_name?: string;
  active_mps: boolean;
  sex?: string;
  current_fr_id?: string;
  current_fr_name?: string;
  main_komitet_id?: string;
  main_komitet_name?: string;
  main_komitet_role?: string;
  region?: string;
  district?: string;
  birth_date?: string;
  birth_place?: string;
  photo?: string;
  bio?: string;
  [key: string]: any;
}

export interface RadaBillRawData {
  bill_id?: number;
  id?: number;
  number: string;
  registrationNumber?: string;
  title?: string;
  name?: string;
  registrationDate?: string;
  reg_date?: string;
  registrationSession?: string;
  registrationConvocation?: string;
  type?: string;
  subject?: string;
  rubric?: string;
  currentPhase_date?: string;
  currentPhase_title?: string;
  currentPhase?: { date?: string; title?: string; status?: string };
  status?: string;
  stage?: string;
  initiator?: string;
  initiator_type?: string;
  committee?: string;
  committee_id?: string;
  url?: string;
  [key: string]: any;
}

export interface RadaVotingRawData {
  date: string;
  session: number;
  question_number: number;
  question_text?: string;
  bill_number?: string;
  type?: string;
  total: number;
  for: number;
  against: number;
  abstain: number;
  not_present: number;
  result?: string;
  votes?: { [deputyId: string]: string };
  [key: string]: any;
}

export interface RadaFactionRawData {
  id: string;
  name: string;
  type: number; // 1 = faction, 2 = committee, etc.
  count?: number;
  created?: string;
  [key: string]: any;
}

// zakon.rada.gov.ua API types

export interface ZakonRadaLawResponse {
  number: string;
  title: string;
  type?: string;
  date_adoption?: string;
  date_effective?: string;
  status?: string;
  url: string;
  html: string;
  text: string;
}

export interface ZakonRadaSearchResult {
  title: string;
  number: string;
  url: string;
  snippet?: string;
}

// RADA MCP Tool Arguments

export interface SearchParliamentBillsArgs {
  query: string;
  status?: 'registered' | 'first_reading' | 'second_reading' | 'adopted' | 'rejected' | 'all';
  initiator?: string;
  committee?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

export interface GetDeputyInfoArgs {
  name?: string;
  rada_id?: string;
  faction?: string;
  include_voting_record?: boolean;
  include_assistants?: boolean;
}

export interface SearchLegislationTextArgs {
  law_identifier: string;
  article?: string;
  search_text?: string;
  include_court_citations?: boolean;
}

export interface AnalyzeVotingRecordArgs {
  deputy_name: string;
  date_from?: string;
  date_to?: string;
  bill_number?: string;
  analyze_patterns?: boolean;
}

// Cache configuration

export interface CacheTTLConfig {
  deputies: number; // 7 days default
  bills: number; // 1 day default
  legislation: number; // 30 days default
  voting: number; // 3 days default
}

export const DEFAULT_CACHE_TTL: CacheTTLConfig = {
  deputies: 604800, // 7 days in seconds
  bills: 86400, // 1 day in seconds
  legislation: 2592000, // 30 days in seconds
  voting: 259200, // 3 days in seconds
};

// API Error Types

export class RadaAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public endpoint?: string
  ) {
    super(message);
    this.name = 'RadaAPIError';
  }
}

export class ZakonRadaAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public lawNumber?: string
  ) {
    super(message);
    this.name = 'ZakonRadaAPIError';
  }
}
