/**
 * «Заплановані перевірки» section of get_company_dossier (LEXAI-2315).
 *
 * The plans of state inspections carry no ЄДРПОУ, so openreyestr_search_inspection_plans
 * matches the company's full ЄДР name to the plan's business name and returns rows only
 * when no other live legal entity has the same name; otherwise it answers found:false
 * with ambiguous:true and a message, which the dossier shows as the section message
 * (status "empty"), so a namesake's inspections are never listed as the company's.
 */
import type { SectionSpec } from './company-dossier-tool.js';

export const INSPECTION_PLANS_SECTION: SectionSpec = {
  key: 'inspection_plans',
  title: 'Заплановані перевірки',
  tool: 'openreyestr_search_inspection_plans',
  args: (c) => ({ edrpou: c, limit: 50 }),
  source: {
    name: 'Річні плани заходів державного нагляду (контролю), ІАС «Державний нагляд»',
    freshness: 'inspection_plans',
    note: 'У планах немає коду ЄДРПОУ: записи зіставлено за повною назвою юрособи з ЄДР і показано, лише якщо інших чинних юросіб з такою самою назвою в ЄДР немає.',
  },
};
