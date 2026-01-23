/**
 * Tests for Zakononline Domain Configuration
 *
 * Tests domain configuration types and helper functions:
 * - ZAKONONLINE_DOMAINS configuration
 * - getDomainConfig()
 * - isValidTarget()
 * - getAvailableDateFields()
 * - getDateFieldName()
 */

import {
  ZAKONONLINE_DOMAINS,
  getDomainConfig,
  isValidTarget,
  getAvailableDateFields,
  getDateFieldName,
} from '../../types/zakononline-domains.js';

describe('Zakononline Domain Configuration', () => {
  describe('ZAKONONLINE_DOMAINS', () => {
    test('should have 4 domains configured', () => {
      const domainNames = Object.keys(ZAKONONLINE_DOMAINS);
      expect(domainNames).toHaveLength(4);
    });

    test('should include all expected domains', () => {
      expect(ZAKONONLINE_DOMAINS).toHaveProperty('court_decisions');
      expect(ZAKONONLINE_DOMAINS).toHaveProperty('court_sessions');
      expect(ZAKONONLINE_DOMAINS).toHaveProperty('legal_acts');
      expect(ZAKONONLINE_DOMAINS).toHaveProperty('court_practice');
    });

    test('each domain should have required fields', () => {
      Object.values(ZAKONONLINE_DOMAINS).forEach(domain => {
        expect(domain).toHaveProperty('name');
        expect(domain).toHaveProperty('displayName');
        expect(domain).toHaveProperty('baseURL');
        expect(domain).toHaveProperty('endpoints');
        expect(domain).toHaveProperty('availableTargets');
        expect(domain).toHaveProperty('defaultTarget');
        expect(domain).toHaveProperty('dateFields');
      });
    });

    test('each domain should have search and meta endpoints', () => {
      Object.values(ZAKONONLINE_DOMAINS).forEach(domain => {
        expect(domain.endpoints).toHaveProperty('search');
        expect(domain.endpoints).toHaveProperty('meta');
        expect(domain.endpoints).toHaveProperty('dictionaries');
      });
    });
  });

  describe('Court Decisions Domain', () => {
    const domain = ZAKONONLINE_DOMAINS.court_decisions;

    test('should have correct name and display name', () => {
      expect(domain.name).toBe('court_decisions');
      expect(domain.displayName).toBe('Судові рішення');
    });

    test('should have correct base URL', () => {
      expect(domain.baseURL).toBe('https://court.searcher.api.zakononline.com.ua');
    });

    test('should have correct endpoints', () => {
      expect(domain.endpoints.search).toBe('/v1/search');
      expect(domain.endpoints.meta).toBe('/v1/search/meta');
    });

    test('should have correct available targets', () => {
      expect(domain.availableTargets).toEqual(['text', 'title']);
      expect(domain.defaultTarget).toBe('text');
    });

    test('should have correct date fields', () => {
      expect(domain.dateFields.publication).toBe('date_publ');
      expect(domain.dateFields.adjudication).toBe('adjudication_date');
      expect(domain.dateFields.receipt).toBe('receipt_date');
    });

    test('should have correct default sort field', () => {
      expect(domain.defaultSortField).toBe('receipt_date');
    });

    test('should have dictionaries configured', () => {
      expect(domain.endpoints.dictionaries).toHaveProperty('courts');
      expect(domain.endpoints.dictionaries).toHaveProperty('judges');
      expect(domain.endpoints.dictionaries).toHaveProperty('regions');
    });
  });

  describe('Court Sessions Domain', () => {
    const domain = ZAKONONLINE_DOMAINS.court_sessions;

    test('should have correct name and display name', () => {
      expect(domain.name).toBe('court_sessions');
      expect(domain.displayName).toBe('Судові засідання');
    });

    test('should have correct base URL', () => {
      expect(domain.baseURL).toBe('https://court.searcher.api.zakononline.com.ua');
    });

    test('should have correct endpoints', () => {
      expect(domain.endpoints.search).toBe('/v1/court_sessions/search');
      expect(domain.endpoints.meta).toBe('/v1/court_sessions/search/meta');
    });

    test('should have correct available targets', () => {
      expect(domain.availableTargets).toEqual(['cause_num', 'case_involved']);
      expect(domain.defaultTarget).toBe('case_involved');
    });

    test('should have correct date fields', () => {
      expect(domain.dateFields.session).toBe('date_session');
    });

    test('should have correct default sort field', () => {
      expect(domain.defaultSortField).toBe('date_session');
    });
  });

  describe('Legal Acts Domain', () => {
    const domain = ZAKONONLINE_DOMAINS.legal_acts;

    test('should have correct name and display name', () => {
      expect(domain.name).toBe('legal_acts');
      expect(domain.displayName).toBe('Нормативно-правові акти');
    });

    test('should have correct base URL (different from court domains)', () => {
      expect(domain.baseURL).toBe('https://searcher.api.zakononline.com.ua');
    });

    test('should have correct endpoints', () => {
      expect(domain.endpoints.search).toBe('/v1/search');
      expect(domain.endpoints.meta).toBe('/v1/search/meta');
    });

    test('should have correct available targets', () => {
      expect(domain.availableTargets).toEqual(['title', 'text']);
      expect(domain.defaultTarget).toBe('title');
    });

    test('should have correct date fields', () => {
      expect(domain.dateFields.version).toBe('version_date');
    });

    test('should have correct dictionaries', () => {
      expect(domain.endpoints.dictionaries).toHaveProperty('documentTypes');
      expect(domain.endpoints.dictionaries).toHaveProperty('authors');
    });
  });

  describe('Court Practice Domain', () => {
    const domain = ZAKONONLINE_DOMAINS.court_practice;

    test('should have correct name and display name', () => {
      expect(domain.name).toBe('court_practice');
      expect(domain.displayName).toBe('Судова практика');
    });

    test('should have correct base URL (unique)', () => {
      expect(domain.baseURL).toBe('https://courtpractice.searcher.api.zakononline.com.ua');
    });

    test('should have correct endpoints', () => {
      expect(domain.endpoints.search).toBe('/v1/search');
      expect(domain.endpoints.meta).toBe('/v1/search/meta');
    });

    test('should have correct available targets', () => {
      expect(domain.availableTargets).toEqual(['text']);
      expect(domain.defaultTarget).toBe('text');
    });

    test('should have correct dictionaries', () => {
      expect(domain.endpoints.dictionaries).toHaveProperty('categories');
      expect(domain.endpoints.dictionaries).toHaveProperty('types');
    });
  });

  describe('getDomainConfig()', () => {
    test('should return config for court_decisions', () => {
      const config = getDomainConfig('court_decisions');
      expect(config.name).toBe('court_decisions');
    });

    test('should return config for court_sessions', () => {
      const config = getDomainConfig('court_sessions');
      expect(config.name).toBe('court_sessions');
    });

    test('should return config for legal_acts', () => {
      const config = getDomainConfig('legal_acts');
      expect(config.name).toBe('legal_acts');
    });

    test('should return config for court_practice', () => {
      const config = getDomainConfig('court_practice');
      expect(config.name).toBe('court_practice');
    });

    test('should return same object as direct access', () => {
      const config1 = getDomainConfig('court_decisions');
      const config2 = ZAKONONLINE_DOMAINS.court_decisions;
      expect(config1).toBe(config2);
    });
  });

  describe('isValidTarget()', () => {
    test('should return true for valid target in court_decisions', () => {
      expect(isValidTarget('court_decisions', 'text')).toBe(true);
      expect(isValidTarget('court_decisions', 'title')).toBe(true);
    });

    test('should return false for invalid target in court_decisions', () => {
      expect(isValidTarget('court_decisions', 'cause_num')).toBe(false);
      expect(isValidTarget('court_decisions', 'case_involved')).toBe(false);
    });

    test('should return true for valid target in court_sessions', () => {
      expect(isValidTarget('court_sessions', 'cause_num')).toBe(true);
      expect(isValidTarget('court_sessions', 'case_involved')).toBe(true);
    });

    test('should return false for invalid target in court_sessions', () => {
      expect(isValidTarget('court_sessions', 'title')).toBe(false);
    });

    test('should validate different targets per domain', () => {
      // 'text' is valid in multiple domains
      expect(isValidTarget('court_decisions', 'text')).toBe(true);
      expect(isValidTarget('legal_acts', 'text')).toBe(true);
      expect(isValidTarget('court_practice', 'text')).toBe(true);

      // 'cause_num' is only valid in court_sessions
      expect(isValidTarget('court_sessions', 'cause_num')).toBe(true);
      expect(isValidTarget('court_decisions', 'cause_num')).toBe(false);
      expect(isValidTarget('legal_acts', 'cause_num')).toBe(false);
    });
  });

  describe('getAvailableDateFields()', () => {
    test('should return date fields for court_decisions', () => {
      const fields = getAvailableDateFields('court_decisions');
      expect(fields.publication).toBe('date_publ');
      expect(fields.adjudication).toBe('adjudication_date');
      expect(fields.receipt).toBe('receipt_date');
    });

    test('should return date fields for court_sessions', () => {
      const fields = getAvailableDateFields('court_sessions');
      expect(fields.session).toBe('date_session');
      expect(fields.publication).toBeUndefined();
    });

    test('should return date fields for legal_acts', () => {
      const fields = getAvailableDateFields('legal_acts');
      expect(fields.version).toBe('version_date');
      expect(fields.publication).toBeUndefined();
    });
  });

  describe('getDateFieldName()', () => {
    test('should return correct field name for court_decisions', () => {
      expect(getDateFieldName('court_decisions', 'publication')).toBe('date_publ');
      expect(getDateFieldName('court_decisions', 'adjudication')).toBe('adjudication_date');
      expect(getDateFieldName('court_decisions', 'receipt')).toBe('receipt_date');
    });

    test('should return undefined for non-existent field', () => {
      expect(getDateFieldName('court_decisions', 'session')).toBeUndefined();
      expect(getDateFieldName('court_sessions', 'publication')).toBeUndefined();
    });

    test('should return correct field name for court_sessions', () => {
      expect(getDateFieldName('court_sessions', 'session')).toBe('date_session');
    });

    test('should return correct field name for legal_acts', () => {
      expect(getDateFieldName('legal_acts', 'version')).toBe('version_date');
    });
  });

  describe('Domain Uniqueness', () => {
    test('all domains should have unique base URLs', () => {
      const baseURLs = Object.values(ZAKONONLINE_DOMAINS).map(d => d.baseURL);
      const uniqueURLs = new Set(baseURLs);

      // court_decisions and court_sessions share base URL, so we expect 3 unique URLs
      expect(uniqueURLs.size).toBe(3);
    });

    test('all domains should have unique names', () => {
      const names = Object.values(ZAKONONLINE_DOMAINS).map(d => d.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(4);
    });

    test('all domains should have unique display names', () => {
      const displayNames = Object.values(ZAKONONLINE_DOMAINS).map(d => d.displayName);
      const uniqueDisplayNames = new Set(displayNames);
      expect(uniqueDisplayNames.size).toBe(4);
    });
  });

  describe('Configuration Consistency', () => {
    test('all search endpoints should start with /v1/', () => {
      Object.values(ZAKONONLINE_DOMAINS).forEach(domain => {
        expect(domain.endpoints.search).toMatch(/^\/v1\//);
      });
    });

    test('all meta endpoints should end with /meta', () => {
      Object.values(ZAKONONLINE_DOMAINS).forEach(domain => {
        expect(domain.endpoints.meta).toMatch(/\/meta$/);
      });
    });

    test('all domains should have at least one date field', () => {
      Object.values(ZAKONONLINE_DOMAINS).forEach(domain => {
        const dateFieldCount = Object.keys(domain.dateFields).length;
        expect(dateFieldCount).toBeGreaterThan(0);
      });
    });

    test('all domains should have at least one available target', () => {
      Object.values(ZAKONONLINE_DOMAINS).forEach(domain => {
        expect(domain.availableTargets.length).toBeGreaterThan(0);
      });
    });

    test('default target should be in available targets', () => {
      Object.values(ZAKONONLINE_DOMAINS).forEach(domain => {
        expect(domain.availableTargets).toContain(domain.defaultTarget);
      });
    });

    test('all domains should have dictionaries object', () => {
      Object.values(ZAKONONLINE_DOMAINS).forEach(domain => {
        expect(domain.endpoints.dictionaries).toBeDefined();
        expect(typeof domain.endpoints.dictionaries).toBe('object');
      });
    });
  });

  describe('Base URL Patterns', () => {
    test('court domains should use court.searcher subdomain', () => {
      expect(ZAKONONLINE_DOMAINS.court_decisions.baseURL).toContain('court.searcher');
      expect(ZAKONONLINE_DOMAINS.court_sessions.baseURL).toContain('court.searcher');
    });

    test('legal acts should use searcher subdomain', () => {
      expect(ZAKONONLINE_DOMAINS.legal_acts.baseURL).toContain('searcher');
      expect(ZAKONONLINE_DOMAINS.legal_acts.baseURL).not.toContain('court.searcher');
    });

    test('court practice should use courtpractice.searcher subdomain', () => {
      expect(ZAKONONLINE_DOMAINS.court_practice.baseURL).toContain('courtpractice.searcher');
    });

    test('all base URLs should use HTTPS', () => {
      Object.values(ZAKONONLINE_DOMAINS).forEach(domain => {
        expect(domain.baseURL).toMatch(/^https:\/\//);
      });
    });

    test('all base URLs should point to zakononline.com.ua', () => {
      Object.values(ZAKONONLINE_DOMAINS).forEach(domain => {
        expect(domain.baseURL).toContain('zakononline.com.ua');
      });
    });
  });
});
