// A tenant is one deployment of the CRM: brand, language, timezone, the registry it
// reads lawyers from, the practice taxonomy and which features are on. The Ukrainian
// tenant (attorney.legal.org.ua) and the Polish one (attorney.lawrider.pl) share all
// code and differ only in the object built here.
import type { NoteKind, Stage } from '../practices';

export interface Strings {
  nav: { today: string; advocates: string; logout: string };
  brandTagline: string;
  login: { title: string; heading: string; email: string; password: string; submit: string; badCredentials: string; blocked: string };
  list: {
    title: string; countSuffix: string; surnameStartsWith: string; surnamePlaceholder: string; city: string; region: string; all: string;
    derivedPractice: string; manualPractice: string; declaredPractice: string; profession: string; stage: string; show: string; reset: string;
    contacts: string; noContact: string; orgColumn: string; certColumn: string; practicesColumn: string; casesColumn: string;
    casesFor: (name: string) => string; stageColumn: string; nextContact: string; lastContact: string; contactWord: string; empty: string;
    prev: string; next: string; pageOf: (page: number, pages: number, total: string) => string; derivedTitle: string;
  };
  detail: {
    back: string; registrySection: string; phone: string; email: string; address: string; cityRegion: string; org: string; council: string;
    certificate: string; decision: string; authority: string; status: string; registryId: string; from: string; practiceSection: string;
    noMentions: string; topCategories: string; declaredSection: string; declaredNone: string; otherTags: string; profileLink: string;
    directoryLink: string; leadSection: string; stageField: string; nextContactField: string; overdue: string; manualTags: string; save: string;
    notesSection: string; noteBody: string; addNote: string; noNotes: string; doNotContact: string; doNotContactReason: string;
    phoneOverride: string; emailOverride: string; manualMark: string; notFoundTitle: string; notFoundHeading: string; notFoundBody: (id: string) => string;
    /** Badge next to the e-mail when the address is on the suppression list. */
    suppressed: (reason: string, date: string) => string;
  };
  /** Public unsubscribe page (/u/:token), shown to the recipient in the tenant's language. */
  unsubscribe: {
    title: string; heading: string; body: (email: string) => string; confirm: string;
    doneHeading: string; doneBody: (email: string) => string; invalidHeading: string; invalidBody: string;
  };
  suppressionReasons: Record<'unsubscribe' | 'bounce' | 'complaint' | 'manual', string>;
  today: {
    title: string; callToday: string; nothingDue: string; date: string; name: string; city: string; phone: string; stage: string; lastNote: string;
    newNotes: string; noNotes: string; overdue: string;
  };
  stages: Record<Stage, string>;
  noteKinds: Record<NoteKind, string>;
  status: Record<string, string>;
  profession: Record<string, string>;
  errors: {
    notFound: string; serverError: string; serverErrorHeading: string; serverErrorBody: string;
    unknownStage: (s: string) => string; unknownPractice: (p: string) => string; unknownNoteKind: (k: string) => string; emptyNote: string;
  };
}

/** SQL fragments over the registry table, aliased `a`, producing the AdvocateRow raw columns. */
export interface RegistryAdapter {
  table: string;
  idColumn: string;
  select: string;
  activeWhere: string;
  surnameColumn: string;
  firstNameColumn: string;
  patronymicColumn: string | null;
  citySql: string;
  regionSql: string;
  professionSql: string | null;
  declaredPracticesSql: string | null;
  phoneSqlForToday: string;
  citySqlForToday: string;
}

export interface Tenant {
  id: 'ua' | 'pl';
  lang: 'uk' | 'en';
  timeZone: string;
  locale: string;
  /** logo: topbar (on the dark bar); mark: square icon for the tab and the login card (both files under static/). */
  brand: { name: string; domain: string; logo: string; mark: string; tagline: string };
  strings: Strings;
  registry: RegistryAdapter;
  practices: readonly string[];
  practiceLabel: (code: string) => string;
  derivedPractices: boolean;
  schema: string | null;
  sqlFiles: string[];
}
