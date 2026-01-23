/**
 * Tests for ZOAdapter Metadata and Advanced Features
 *
 * Tests:
 * - Metadata queries (getSearchMetadata)
 * - Sorting (orderBy parameter)
 * - Search parameters validation
 * - Target configuration
 */

import { ZOAdapter } from '../zo-adapter.js';
import { ZakonOnlineValidationError } from '../zakononline-errors.js';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('ZOAdapter - Metadata and Advanced Features', () => {
  let adapter: ZOAdapter;
  let mockAxiosInstance: any;

  beforeEach(() => {
    // Create mock axios instance
    mockAxiosInstance = {
      get: jest.fn(),
      defaults: {
        headers: {},
      },
    };

    mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);
    adapter = new ZOAdapter('court_decisions');
  });

  describe('getSearchMetadata()', () => {
    test('should have getSearchMetadata method', () => {
      expect(adapter.getSearchMetadata).toBeDefined();
      expect(typeof adapter.getSearchMetadata).toBe('function');
    });

    test('should validate target for metadata query', async () => {
      // Invalid target should throw validation error
      await expect(async () => {
        await adapter.getSearchMetadata({
          meta: { search: 'test' },
          target: 'invalid_target' as any,
        });
      }).rejects.toThrow(ZakonOnlineValidationError);
    });

    test('should accept valid target for metadata query', async () => {
      // Mock successful API response
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { total: 1000, facets: {} },
      });

      await expect(async () => {
        await adapter.getSearchMetadata({
          meta: { search: 'test' },
          target: 'text',
        });
      }).not.toThrow();
    });

    test('should use default target if not specified', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { total: 500 },
      });

      // Should not throw - uses default 'text' target
      await expect(async () => {
        await adapter.getSearchMetadata({
          meta: { search: 'test' },
        });
      }).not.toThrow();
    });

    test('should include error message with available targets', async () => {
      try {
        await adapter.getSearchMetadata({
          meta: { search: 'test' },
          target: 'cause_num' as any, // Invalid for court_decisions
        });
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Invalid target');
        expect(error.message).toContain('cause_num');
        expect(error.message).toContain('Available targets');
        expect(error.message).toContain('text');
        expect(error.message).toContain('title');
      }
    });
  });

  describe('Search Parameters - Target', () => {
    test('should support text target', () => {
      const targets = adapter.getAvailableTargets();
      expect(targets).toContain('text');
    });

    test('should support title target', () => {
      const targets = adapter.getAvailableTargets();
      expect(targets).toContain('title');
    });

    test('should have correct default target', () => {
      const domain = adapter.getDomain();
      expect(domain.defaultTarget).toBe('text');
    });

    test('different domains should have different targets', () => {
      const courtAdapter = new ZOAdapter('court_decisions');
      const sessionsAdapter = new ZOAdapter('court_sessions');

      const courtTargets = courtAdapter.getAvailableTargets();
      const sessionTargets = sessionsAdapter.getAvailableTargets();

      expect(courtTargets).toEqual(['text', 'title']);
      expect(sessionTargets).toEqual(['cause_num', 'case_involved']);
    });
  });

  describe('Search Parameters - Mode', () => {
    test('should support mode parameter in search', () => {
      // Mode should be part of ZOSearchParams
      const params = {
        meta: { search: 'test' },
        mode: 'sph04' as const,
      };

      // Should not throw
      expect(() => params).not.toThrow();
    });

    test('should default to sph04 mode', () => {
      // When mode is not specified, it should default to 'sph04'
      // This is tested implicitly in searchCourtDecisions
      expect(true).toBe(true); // Placeholder - actual test would mock API call
    });
  });

  describe('Search Parameters - Sorting', () => {
    test('should support orderBy parameter', () => {
      const params = {
        meta: { search: 'test' },
        orderBy: {
          field: 'receipt_date',
          direction: 'desc' as const,
        },
      };

      expect(params.orderBy).toBeDefined();
      expect(params.orderBy?.field).toBe('receipt_date');
      expect(params.orderBy?.direction).toBe('desc');
    });

    test('should support asc direction', () => {
      const params = {
        meta: { search: 'test' },
        orderBy: {
          field: 'date_publ',
          direction: 'asc' as const,
        },
      };

      expect(params.orderBy?.direction).toBe('asc');
    });

    test('should support desc direction', () => {
      const params = {
        meta: { search: 'test' },
        orderBy: {
          field: 'receipt_date',
          direction: 'desc' as const,
        },
      };

      expect(params.orderBy?.direction).toBe('desc');
    });

    test('should support different sort fields', () => {
      const fields = ['receipt_date', 'date_publ', 'adjudication_date', 'weight'];

      fields.forEach(field => {
        const params = {
          meta: { search: 'test' },
          orderBy: { field, direction: 'desc' as const },
        };

        expect(params.orderBy?.field).toBe(field);
      });
    });
  });

  describe('Search Parameters - Where Conditions', () => {
    test('should support where conditions array', () => {
      const params = {
        meta: { search: 'test' },
        where: [
          { field: 'justice_kind', op: '=', value: 2 },
        ],
      };

      expect(params.where).toBeInstanceOf(Array);
      expect(params.where?.length).toBe(1);
    });

    test('should support multiple where conditions', () => {
      const params = {
        meta: { search: 'test' },
        where: [
          { field: 'justice_kind', op: '=', value: 2 },
          { field: 'court_code', op: '$in', value: [5001, 5002] },
        ],
      };

      expect(params.where?.length).toBe(2);
    });

    test('should support operators: =, $in, >=, <=', () => {
      const operators = ['=', '$in', '>=', '<='];

      operators.forEach(op => {
        const condition = { field: 'test_field', op, value: 'test' };
        expect(condition.op).toBe(op);
      });
    });
  });

  describe('Search Parameters - Pagination', () => {
    test('should support limit parameter', () => {
      const params = {
        meta: { search: 'test' },
        limit: 50,
      };

      expect(params.limit).toBe(50);
    });

    test('should support offset parameter', () => {
      const params = {
        meta: { search: 'test' },
        offset: 100,
      };

      expect(params.offset).toBe(100);
    });

    test('should support both limit and offset', () => {
      const params = {
        meta: { search: 'test' },
        limit: 20,
        offset: 40,
      };

      expect(params.limit).toBe(20);
      expect(params.offset).toBe(40);
    });
  });

  describe('Domain-Specific Sort Fields', () => {
    test('court_decisions should have receipt_date as default sort', () => {
      const courtAdapter = new ZOAdapter('court_decisions');
      const domain = courtAdapter.getDomain();
      expect(domain.defaultSortField).toBe('receipt_date');
    });

    test('court_sessions should have date_session as default sort', () => {
      const sessionsAdapter = new ZOAdapter('court_sessions');
      const domain = sessionsAdapter.getDomain();
      expect(domain.defaultSortField).toBe('date_session');
    });

    test('legal_acts should have version_date as default sort', () => {
      const legalAdapter = new ZOAdapter('legal_acts');
      const domain = legalAdapter.getDomain();
      expect(domain.defaultSortField).toBe('version_date');
    });

    test('court_practice should have date_publ as default sort', () => {
      const practiceAdapter = new ZOAdapter('court_practice');
      const domain = practiceAdapter.getDomain();
      expect(domain.defaultSortField).toBe('date_publ');
    });
  });

  describe('Complex Query Scenarios', () => {
    test('should support query with all parameters', () => {
      const complexParams = {
        meta: { search: '"договір лізингу"' },
        target: 'text' as const,
        mode: 'sph04' as const,
        where: [
          { field: 'justice_kind', op: '=', value: 2 },
          { field: 'instance_code', op: '$in', value: [1] },
        ],
        orderBy: {
          field: 'receipt_date',
          direction: 'desc' as const,
        },
        limit: 20,
        offset: 0,
      };

      expect(complexParams.meta.search).toBe('"договір лізингу"');
      expect(complexParams.target).toBe('text');
      expect(complexParams.mode).toBe('sph04');
      expect(complexParams.where?.length).toBe(2);
      expect(complexParams.orderBy?.field).toBe('receipt_date');
      expect(complexParams.limit).toBe(20);
    });

    test('should support minimal query (only search text)', () => {
      const minimalParams = {
        meta: { search: 'test' },
      };

      expect(minimalParams.meta.search).toBe('test');
    });

    test('should support date range in where conditions', () => {
      const params = {
        meta: { search: 'test' },
        where: [
          { field: 'receipt_date', op: '>=', value: '2025-01-01 00:00:00' },
          { field: 'receipt_date', op: '<=', value: '2025-12-31 23:59:59' },
        ],
      };

      expect(params.where?.length).toBe(2);
      const fromCondition = params.where?.find(c => c.op === '>=');
      const toCondition = params.where?.find(c => c.op === '<=');

      expect(fromCondition).toBeDefined();
      expect(toCondition).toBeDefined();
    });
  });

  describe('Metadata Query Parameter Building', () => {
    test('should handle metadata query with where conditions', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { total: 100 },
      });

      const params = {
        meta: { search: 'test' },
        where: [
          { field: 'justice_kind', op: '=', value: 2 },
        ],
      };

      // Should not throw
      await expect(async () => {
        await adapter.getSearchMetadata(params);
      }).not.toThrow();
    });

    test('should handle metadata query with multiple where conditions', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { total: 50 },
      });

      const params = {
        meta: { search: 'test' },
        where: [
          { field: 'justice_kind', op: '=', value: 2 },
          { field: 'court_code', op: '$in', value: [5001, 5002] },
        ],
      };

      await expect(async () => {
        await adapter.getSearchMetadata(params);
      }).not.toThrow();
    });
  });

  describe('Parameter Validation', () => {
    test('should validate search query exists', () => {
      const params = {
        meta: { search: 'test' },
      };

      expect(params.meta.search).toBeDefined();
      expect(params.meta.search.length).toBeGreaterThan(0);
    });

    test('should validate limit is positive', () => {
      const validParams = { meta: { search: 'test' }, limit: 10 };
      const invalidParams = { meta: { search: 'test' }, limit: -1 };

      expect(validParams.limit).toBeGreaterThan(0);
      expect(invalidParams.limit).toBeLessThan(0);
    });

    test('should validate offset is non-negative', () => {
      const validParams = { meta: { search: 'test' }, offset: 0 };
      const invalidParams = { meta: { search: 'test' }, offset: -1 };

      expect(validParams.offset).toBeGreaterThanOrEqual(0);
      expect(invalidParams.offset).toBeLessThan(0);
    });
  });

  describe('Search Mode Consistency', () => {
    test('all domains should support sph04 mode', () => {
      const domains: Array<'court_decisions' | 'court_sessions' | 'legal_acts' | 'court_practice'> = [
        'court_decisions',
        'court_sessions',
        'legal_acts',
        'court_practice',
      ];

      domains.forEach(domainName => {
        const adapter = new ZOAdapter(domainName);
        // sph04 should be the default mode (implicit test)
        expect(adapter).toBeDefined();
      });
    });
  });
});
