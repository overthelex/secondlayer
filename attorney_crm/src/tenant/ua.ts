// attorney.legal.org.ua: Ukrainian advocates from opendata_advocates, practices derived from ЄДРСР.
import type { Tenant } from './types';
import { uk } from '../i18n/uk';
import { NAAU_PRACTICES } from '../practices';
import { UA_REGISTRY } from '../advocates/registry-sql';

export const UA_TENANT: Tenant = {
  id: 'ua',
  lang: 'uk',
  timeZone: 'Europe/Kyiv',
  locale: 'uk-UA',
  brand: { name: 'legal.org.ua', domain: 'legal.org.ua', logo: 'logo-white.png', mark: 'favicon.svg', tagline: uk.brandTagline },
  strings: uk,
  registry: UA_REGISTRY,
  practices: NAAU_PRACTICES,
  practiceLabel: (code) => code,
  derivedPractices: true,
  schema: null,
  sqlFiles: ['001_practice_derivation.sql', '002_crm_core.sql', '003_ctid_backfill.sql', '004_contact_overrides.sql'],
};
