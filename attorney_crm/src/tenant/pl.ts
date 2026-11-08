// attorney.lawrider.pl: Polish adwokaci and radcowie prawni from public.pl_lawyers,
// English UI, lawrider branding, declared (not court-derived) practice areas.
import type { Tenant } from './types';
import { en } from '../i18n/en';
import { PL_REGISTRY } from '../advocates/registry-pl';
import { PL_PRACTICE_CODES, plPracticeLabel } from './pl-practices';

export const PL_TENANT: Tenant = {
  id: 'pl',
  lang: 'en',
  timeZone: 'Europe/Warsaw',
  locale: 'en-GB',
  brand: { name: 'lawrider.pl', domain: 'lawrider.pl', logo: 'logo-lawrider.png', mark: 'logo-lawrider.png', tagline: en.brandTagline },
  strings: en,
  registry: PL_REGISTRY,
  practices: PL_PRACTICE_CODES,
  practiceLabel: plPracticeLabel,
  derivedPractices: false,
  schema: 'attorney_crm_pl',
  sqlFiles: ['002_crm_core.sql', '004_contact_overrides.sql', 'pl/001_pl_lawyers.sql'],
};
