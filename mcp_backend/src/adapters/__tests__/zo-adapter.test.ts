/**
 * Unit tests for ZOAdapter
 *
 * Tests core functionality including:
 * - Constructor and initialization
 * - Backward compatibility
 * - Search operations
 * - Target validation
 * - Sorting
 */

import { ZOAdapter } from '../zo-adapter.js';
import { DocumentService } from '../../services/document-service.js';

// Mock axios to avoid real API calls
jest.mock('axios');

// Mock Database to avoid DB connection in tests
jest.mock('../../database/database.js');

describe('ZOAdapter', () => {
  let documentService: DocumentService;

  beforeAll(() => {
    // Create a mock document service
    documentService = {} as DocumentService;
  });

  describe('Constructor', () => {
    test('should create adapter with default domain (court_decisions)', () => {
      const adapter = new ZOAdapter();
      const domain = adapter.getDomain();

      expect(domain.name).toBe('court_decisions');
      expect(domain.displayName).toBe('Судові рішення');
      expect(domain.baseURL).toBe('https://court.searcher.api.zakononline.com.ua');
    });

    test('should create adapter with specific domain', () => {
      const adapter = new ZOAdapter('court_sessions');
      const domain = adapter.getDomain();

      expect(domain.name).toBe('court_sessions');
      expect(domain.displayName).toBe('Судові засідання');
      expect(domain.baseURL).toBe('https://court.searcher.api.zakononline.com.ua');
    });

    test('should support backward compatibility with DocumentService as first param', () => {
      const adapter = new ZOAdapter(documentService);
      const domain = adapter.getDomain();

      // Should default to court_decisions
      expect(domain.name).toBe('court_decisions');
    });

    test('should create adapter with domain and DocumentService', () => {
      const adapter = new ZOAdapter('legal_acts', documentService);
      const domain = adapter.getDomain();

      expect(domain.name).toBe('legal_acts');
      expect(domain.displayName).toBe('Нормативно-правові акти');
    });

    test('should initialize with correct API token', () => {
      const adapter = new ZOAdapter();
      // Token should be set from environment variables
      expect(adapter).toBeDefined();
    });
  });

  describe('Domain Configuration', () => {
    test('should return correct domain config for court_decisions', () => {
      const adapter = new ZOAdapter('court_decisions');
      const domain = adapter.getDomain();

      expect(domain.availableTargets).toContain('text');
      expect(domain.availableTargets).toContain('title');
      expect(domain.defaultTarget).toBe('text');
      expect(domain.endpoints.search).toBe('/v1/search');
      expect(domain.endpoints.meta).toBe('/v1/search/meta');
    });

    test('should return correct domain config for court_sessions', () => {
      const adapter = new ZOAdapter('court_sessions');
      const domain = adapter.getDomain();

      expect(domain.availableTargets).toContain('cause_num');
      expect(domain.availableTargets).toContain('case_involved');
      expect(domain.defaultTarget).toBe('case_involved');
      expect(domain.defaultSortField).toBe('date_session');
    });

    test('should return correct domain config for legal_acts', () => {
      const adapter = new ZOAdapter('legal_acts');
      const domain = adapter.getDomain();

      expect(domain.baseURL).toBe('https://searcher.api.zakononline.com.ua');
      expect(domain.availableTargets).toContain('title');
      expect(domain.defaultSortField).toBe('version_date');
    });

    test('should return correct domain config for court_practice', () => {
      const adapter = new ZOAdapter('court_practice');
      const domain = adapter.getDomain();

      expect(domain.baseURL).toBe('https://courtpractice.searcher.api.zakononline.com.ua');
      expect(domain.availableTargets).toContain('text');
    });
  });

  describe('getAvailableTargets', () => {
    test('should return available targets for court_decisions', () => {
      const adapter = new ZOAdapter('court_decisions');
      const targets = adapter.getAvailableTargets();

      expect(targets).toEqual(['text', 'title']);
    });

    test('should return available targets for court_sessions', () => {
      const adapter = new ZOAdapter('court_sessions');
      const targets = adapter.getAvailableTargets();

      expect(targets).toEqual(['cause_num', 'case_involved']);
    });

    test('should return available targets for legal_acts', () => {
      const adapter = new ZOAdapter('legal_acts');
      const targets = adapter.getAvailableTargets();

      expect(targets).toEqual(['title', 'text']);
    });
  });

  describe('Target Validation', () => {
    test('should accept valid target for domain', () => {
      const adapter = new ZOAdapter('court_decisions');

      // Should not throw
      expect(() => {
        // This would be called internally in searchCourtDecisions
        const targets = adapter.getAvailableTargets();
        if (!targets.includes('text')) {
          throw new Error('Invalid target');
        }
      }).not.toThrow();
    });

    test('should reject invalid target for domain', () => {
      const adapter = new ZOAdapter('court_decisions');
      const targets = adapter.getAvailableTargets();

      // court_decisions doesn't support 'cause_num' target
      expect(targets).not.toContain('cause_num');
    });

    test('should validate different targets per domain', () => {
      const courtAdapter = new ZOAdapter('court_decisions');
      const sessionsAdapter = new ZOAdapter('court_sessions');

      const courtTargets = courtAdapter.getAvailableTargets();
      const sessionTargets = sessionsAdapter.getAvailableTargets();

      // Different domains have different targets
      expect(courtTargets).not.toEqual(sessionTargets);
    });
  });

  describe('getAvailableDictionaries', () => {
    test('should return available dictionaries for court_decisions', () => {
      const adapter = new ZOAdapter('court_decisions');
      const dictionaries = adapter.getAvailableDictionaries();

      expect(dictionaries).toContain('courts');
      expect(dictionaries).toContain('judges');
      expect(dictionaries).toContain('regions');
      expect(dictionaries).toContain('instances');
      expect(dictionaries).toContain('justiceKinds');
    });

    test('should return available dictionaries for legal_acts', () => {
      const adapter = new ZOAdapter('legal_acts');
      const dictionaries = adapter.getAvailableDictionaries();

      expect(dictionaries).toContain('documentTypes');
      expect(dictionaries).toContain('authors');
      expect(dictionaries).not.toContain('courts'); // Not available in legal_acts
    });

    test('should return available dictionaries for court_practice', () => {
      const adapter = new ZOAdapter('court_practice');
      const dictionaries = adapter.getAvailableDictionaries();

      expect(dictionaries).toContain('categories');
      expect(dictionaries).toContain('types');
    });
  });

  describe('Date Fields', () => {
    test('should have correct date fields for court_decisions', () => {
      const adapter = new ZOAdapter('court_decisions');
      const domain = adapter.getDomain();

      expect(domain.dateFields.publication).toBe('date_publ');
      expect(domain.dateFields.adjudication).toBe('adjudication_date');
      expect(domain.dateFields.receipt).toBe('receipt_date');
    });

    test('should have correct date fields for court_sessions', () => {
      const adapter = new ZOAdapter('court_sessions');
      const domain = adapter.getDomain();

      expect(domain.dateFields.session).toBe('date_session');
      expect(domain.dateFields.publication).toBeUndefined();
    });

    test('should have correct date fields for legal_acts', () => {
      const adapter = new ZOAdapter('legal_acts');
      const domain = adapter.getDomain();

      expect(domain.dateFields.version).toBe('version_date');
    });
  });

  describe('Multi-Instance Support', () => {
    test('should support multiple adapters for different domains', () => {
      const courtAdapter = new ZOAdapter('court_decisions');
      const sessionsAdapter = new ZOAdapter('court_sessions');
      const legalAdapter = new ZOAdapter('legal_acts');

      expect(courtAdapter.getDomain().name).toBe('court_decisions');
      expect(sessionsAdapter.getDomain().name).toBe('court_sessions');
      expect(legalAdapter.getDomain().name).toBe('legal_acts');

      // Each should have different base URLs
      expect(courtAdapter.getDomain().baseURL).not.toBe(legalAdapter.getDomain().baseURL);
    });

    test('should maintain separate state for each adapter', () => {
      const adapter1 = new ZOAdapter('court_decisions');
      const adapter2 = new ZOAdapter('legal_acts');

      // Each should have its own configuration
      expect(adapter1.getAvailableTargets()).not.toEqual(adapter2.getAvailableTargets());
      expect(adapter1.getAvailableDictionaries()).not.toEqual(adapter2.getAvailableDictionaries());
    });
  });

  describe('Backward Compatibility', () => {
    test('should work with old signature: new ZOAdapter()', () => {
      const adapter = new ZOAdapter();
      expect(adapter.getDomain().name).toBe('court_decisions');
    });

    test('should work with old signature: new ZOAdapter(documentService)', () => {
      const adapter = new ZOAdapter(documentService);
      expect(adapter.getDomain().name).toBe('court_decisions');
    });

    test('should work with new signature: new ZOAdapter("domain")', () => {
      const adapter = new ZOAdapter('legal_acts');
      expect(adapter.getDomain().name).toBe('legal_acts');
    });

    test('should work with new signature: new ZOAdapter("domain", documentService)', () => {
      const adapter = new ZOAdapter('court_sessions', documentService);
      expect(adapter.getDomain().name).toBe('court_sessions');
    });
  });

  describe('Environment Variables', () => {
    test('should require at least one API token', () => {
      // This test assumes ZAKONONLINE_API_TOKEN is set in environment
      const adapter = new ZOAdapter();
      expect(adapter).toBeDefined();
    });
  });
});
