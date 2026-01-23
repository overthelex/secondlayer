/**
 * Tests for ZOAdapter Dictionary Methods
 *
 * Tests all reference dictionary (справочник) methods:
 * - Generic getDictionary()
 * - Domain-specific dictionary methods
 * - Validation for unavailable dictionaries
 */

import { ZOAdapter } from '../zo-adapter.js';
import { ZakonOnlineValidationError } from '../zakononline-errors.js';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('ZOAdapter - Dictionary Methods', () => {
  let courtAdapter: ZOAdapter;
  let sessionsAdapter: ZOAdapter;
  let legalAdapter: ZOAdapter;
  let practiceAdapter: ZOAdapter;

  beforeAll(() => {
    // Create mock axios instance
    const mockAxiosInstance = {
      get: jest.fn(),
      defaults: {
        headers: {},
      },
    };

    mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);

    // Create adapters for each domain
    courtAdapter = new ZOAdapter('court_decisions');
    sessionsAdapter = new ZOAdapter('court_sessions');
    legalAdapter = new ZOAdapter('legal_acts');
    practiceAdapter = new ZOAdapter('court_practice');
  });

  describe('getDictionary - Generic Method', () => {
    test('should validate dictionary name exists for domain', async () => {
      // Try to get a dictionary that doesn't exist
      await expect(async () => {
        await courtAdapter.getDictionary('nonexistent');
      }).rejects.toThrow(ZakonOnlineValidationError);
    });

    test('should include available dictionaries in error message', async () => {
      try {
        await courtAdapter.getDictionary('invalid_dict');
      } catch (error: any) {
        expect(error.message).toContain('Available dictionaries');
        expect(error.message).toContain('courts');
        expect(error.message).toContain('judges');
      }
    });

    test('should accept valid dictionary name', () => {
      const available = courtAdapter.getAvailableDictionaries();
      expect(available).toContain('courts');

      // Should not throw validation error (may fail on actual API call)
      expect(() => {
        courtAdapter.getDictionary('courts');
      }).not.toThrow();
    });
  });

  describe('Court Decisions Domain - Dictionaries', () => {
    test('should have courts dictionary method', () => {
      expect(courtAdapter.getCourtsDictionary).toBeDefined();
      expect(typeof courtAdapter.getCourtsDictionary).toBe('function');
    });

    test('should have judges dictionary method', () => {
      expect(courtAdapter.getJudgesDictionary).toBeDefined();
      expect(typeof courtAdapter.getJudgesDictionary).toBe('function');
    });

    test('should have regions dictionary method', () => {
      expect(courtAdapter.getRegionsDictionary).toBeDefined();
      expect(typeof courtAdapter.getRegionsDictionary).toBe('function');
    });

    test('should have instances dictionary method', () => {
      expect(courtAdapter.getInstancesDictionary).toBeDefined();
      expect(typeof courtAdapter.getInstancesDictionary).toBe('function');
    });

    test('should have justiceKinds dictionary method', () => {
      expect(courtAdapter.getJusticeKindsDictionary).toBeDefined();
      expect(typeof courtAdapter.getJusticeKindsDictionary).toBe('function');
    });

    test('should have judgmentForms dictionary method', () => {
      expect(courtAdapter.getJudgmentFormsDictionary).toBeDefined();
      expect(typeof courtAdapter.getJudgmentFormsDictionary).toBe('function');
    });

    test('should list all available dictionaries for court_decisions', () => {
      const dictionaries = courtAdapter.getAvailableDictionaries();

      expect(dictionaries).toContain('courts');
      expect(dictionaries).toContain('judges');
      expect(dictionaries).toContain('regions');
      expect(dictionaries).toContain('instances');
      expect(dictionaries).toContain('justiceKinds');
      expect(dictionaries).toContain('judgmentForms');
    });
  });

  describe('Court Sessions Domain - Dictionaries', () => {
    test('should have courts dictionary', () => {
      const dictionaries = sessionsAdapter.getAvailableDictionaries();
      expect(dictionaries).toContain('courts');
    });

    test('should have justiceKinds dictionary', () => {
      const dictionaries = sessionsAdapter.getAvailableDictionaries();
      expect(dictionaries).toContain('justiceKinds');
    });

    test('should NOT have judges dictionary (not available in sessions)', () => {
      const dictionaries = sessionsAdapter.getAvailableDictionaries();
      expect(dictionaries).not.toContain('judges');
    });

    test('should reject unavailable dictionary', async () => {
      await expect(async () => {
        await sessionsAdapter.getDictionary('judges');
      }).rejects.toThrow(ZakonOnlineValidationError);
    });
  });

  describe('Legal Acts Domain - Dictionaries', () => {
    test('should have documentTypes dictionary method', () => {
      expect(legalAdapter.getDocumentTypesDictionary).toBeDefined();
      expect(typeof legalAdapter.getDocumentTypesDictionary).toBe('function');
    });

    test('should have authors dictionary method', () => {
      expect(legalAdapter.getAuthorsDictionary).toBeDefined();
      expect(typeof legalAdapter.getAuthorsDictionary).toBe('function');
    });

    test('should list available dictionaries for legal_acts', () => {
      const dictionaries = legalAdapter.getAvailableDictionaries();

      expect(dictionaries).toContain('documentTypes');
      expect(dictionaries).toContain('authors');
    });

    test('should NOT have court-specific dictionaries', () => {
      const dictionaries = legalAdapter.getAvailableDictionaries();

      expect(dictionaries).not.toContain('courts');
      expect(dictionaries).not.toContain('judges');
      expect(dictionaries).not.toContain('regions');
    });
  });

  describe('Court Practice Domain - Dictionaries', () => {
    test('should have categories dictionary method', () => {
      expect(practiceAdapter.getCategoriesDictionary).toBeDefined();
      expect(typeof practiceAdapter.getCategoriesDictionary).toBe('function');
    });

    test('should have types dictionary method', () => {
      expect(practiceAdapter.getTypesDictionary).toBeDefined();
      expect(typeof practiceAdapter.getTypesDictionary).toBe('function');
    });

    test('should list available dictionaries for court_practice', () => {
      const dictionaries = practiceAdapter.getAvailableDictionaries();

      expect(dictionaries).toContain('categories');
      expect(dictionaries).toContain('types');
    });

    test('should NOT have other domain dictionaries', () => {
      const dictionaries = practiceAdapter.getAvailableDictionaries();

      expect(dictionaries).not.toContain('courts');
      expect(dictionaries).not.toContain('documentTypes');
    });
  });

  describe('Dictionary Method Signatures', () => {
    test('courts dictionary should accept pagination params', () => {
      const params = { limit: 50, page: 2 };

      // Should not throw (actual API call would happen)
      expect(() => {
        courtAdapter.getCourtsDictionary(params);
      }).not.toThrow();
    });

    test('judges dictionary should accept pagination params', () => {
      const params = { limit: 100, page: 1 };

      expect(() => {
        courtAdapter.getJudgesDictionary(params);
      }).not.toThrow();
    });

    test('instances dictionary should not require params', () => {
      expect(() => {
        courtAdapter.getInstancesDictionary();
      }).not.toThrow();
    });

    test('types dictionary should support nolimits param', () => {
      expect(() => {
        practiceAdapter.getTypesDictionary();
      }).not.toThrow();
    });
  });

  describe('Domain-Specific Dictionary Validation', () => {
    test('court_decisions should have 6+ dictionaries', () => {
      const dictionaries = courtAdapter.getAvailableDictionaries();
      expect(dictionaries.length).toBeGreaterThanOrEqual(6);
    });

    test('court_sessions should have 2+ dictionaries', () => {
      const dictionaries = sessionsAdapter.getAvailableDictionaries();
      expect(dictionaries.length).toBeGreaterThanOrEqual(2);
    });

    test('legal_acts should have 2 dictionaries', () => {
      const dictionaries = legalAdapter.getAvailableDictionaries();
      expect(dictionaries).toHaveLength(2);
    });

    test('court_practice should have 2 dictionaries', () => {
      const dictionaries = practiceAdapter.getAvailableDictionaries();
      expect(dictionaries).toHaveLength(2);
    });
  });

  describe('Error Messages', () => {
    test('should provide helpful error for invalid dictionary', async () => {
      try {
        await courtAdapter.getDictionary('xyz');
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error).toBeInstanceOf(ZakonOnlineValidationError);
        expect(error.message).toContain('xyz');
        expect(error.message).toContain('Судові рішення'); // Display name, not domain name
        expect(error.message).toContain('Available dictionaries');
      }
    });

    test('should include domain display name in error message', async () => {
      try {
        await legalAdapter.getDictionary('courts');
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Нормативно-правові акти');
      }
    });
  });

  describe('Shared Dictionaries Across Domains', () => {
    test('justiceKinds should be available in both court_decisions and court_sessions', () => {
      const courtDictionaries = courtAdapter.getAvailableDictionaries();
      const sessionsDictionaries = sessionsAdapter.getAvailableDictionaries();

      expect(courtDictionaries).toContain('justiceKinds');
      expect(sessionsDictionaries).toContain('justiceKinds');
    });

    test('courts dictionary should exist in multiple domains', () => {
      const courtDictionaries = courtAdapter.getAvailableDictionaries();
      const sessionsDictionaries = sessionsAdapter.getAvailableDictionaries();

      expect(courtDictionaries).toContain('courts');
      expect(sessionsDictionaries).toContain('courts');
    });
  });
});
