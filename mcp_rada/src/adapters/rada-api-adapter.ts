/**
 * Adapter for data.rada.gov.ua Open Data API
 * Fetches deputies, bills, voting records, and related data
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { CostTracker } from '../services/cost-tracker';
import {
  RadaDeputyRawData,
  RadaBillRawData,
  RadaVotingRawData,
  RadaFactionRawData,
  RadaAPIError,
} from '../types/rada';

export class RadaAPIAdapter {
  private client: AxiosInstance;
  private baseURL = 'https://data.rada.gov.ua';
  private lastRequestTime: number = 0;
  private minRequestInterval: number = 100; // 100ms between requests (10 rps)
  private _costTracker?: CostTracker;

  // Cache for mps-data.json (contains deputies, factions, committees, assistants)
  private mpsDataCache: Map<number, { data: any; fetchedAt: number }> = new Map();
  private readonly MPS_DATA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'RADA-MCP/1.0',
      },
    });

    void this._costTracker;
    logger.info('RadaAPIAdapter initialized');
  }

  /**
   * Set cost tracker for API usage monitoring
   */
  setCostTracker(costTracker: CostTracker): void {
    this._costTracker = costTracker;
    logger.debug('Cost tracker set for RadaAPIAdapter');
  }

  /**
   * Rate limiting: ensure minimum interval between requests
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Fetch and cache the full mps-data.json for a convocation.
   * This file contains deputies, factions (fr_associations), committees,
   * assistants, parties, regions, and posts — all in one response.
   */
  private async fetchMpsData(convocation: number): Promise<any> {
    const cached = this.mpsDataCache.get(convocation);
    if (cached && Date.now() - cached.fetchedAt < this.MPS_DATA_CACHE_TTL) {
      logger.debug('Using cached mps-data.json', { convocation });
      return cached.data;
    }

    await this.waitForRateLimit();
    const endpoint = `/ogd/mps/skl${convocation}/mps-data.json`;
    logger.info(`Fetching mps-data.json for convocation ${convocation}`);

    const response = await this.client.get(endpoint);
    const data = response.data;
    this.mpsDataCache.set(convocation, { data, fetchedAt: Date.now() });
    return data;
  }

  /**
   * Fetch deputies for a given convocation (скликання)
   * Default: convocation 9 (current)
   */
  async fetchDeputies(convocation: number = 9): Promise<RadaDeputyRawData[]> {
    void this._costTracker;
    const endpoint = `/ogd/mps/skl${convocation}/mps-data.json`;
    logger.info(`Fetching deputies for convocation ${convocation}`);

    try {
      const data = await this.fetchMpsData(convocation);

      // Response can be array directly or object with mps/mps_list/deputies
      if (Array.isArray(data)) {
        return data;
      } else if (data.mps && Array.isArray(data.mps)) {
        return data.mps;
      } else if (data.mps_list && Array.isArray(data.mps_list)) {
        return data.mps_list;
      } else if (data.deputies && Array.isArray(data.deputies)) {
        return data.deputies;
      }

      logger.warn('Unexpected data format for deputies', { convocation });
      return [];
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to fetch deputies for convocation ${convocation}: ${error.message}`;
      logger.error(message, { statusCode, endpoint });
      throw new RadaAPIError(message, statusCode, endpoint);
    }
  }

  /**
   * Fetch single deputy details
   */
  async fetchDeputyById(radaId: string, convocation: number = 9): Promise<RadaDeputyRawData | null> {
    const allDeputies = await this.fetchDeputies(convocation);
    return allDeputies.find((d) => d.id === radaId) || null;
  }

  /**
   * Fetch bills (законопроекти)
   * Uses billinfo_list endpoint which is actively maintained and up-to-date.
   * The older bills_main-skl9.json endpoint is stale (last updated Jan 2025).
   *
   * Available endpoints on data.rada.gov.ua/ogd/zpr/skl9/:
   *   - billinfo_list-skl9.json (~8MB, light list, updated daily) <-- used here
   *   - billinfo-skl9.json (~130MB, full details with documents/passings)
   *   - bills_main-skl9.json (~10MB, STALE since Jan 2025)
   *   - bills-skl9.json (~63MB, STALE since Jan 2025)
   */
  async fetchBills(filters?: { dateFrom?: string; dateTo?: string; convocation?: number }): Promise<RadaBillRawData[]> {
    void this._costTracker;
    await this.waitForRateLimit();

    const convocation = filters?.convocation || 9;
    const endpoint = `/ogd/zpr/skl${convocation}/billinfo_list-skl${convocation}.json`;
    logger.info('Fetching bills', { convocation, filters, endpoint });

    try {
      const response = await this.client.get(endpoint, {
        timeout: 120000, // billinfo_list is ~8MB, allow more time
        maxContentLength: 50 * 1024 * 1024,
      });
      const data = response.data;

      // Response is a JSON array of bill objects
      let bills: RadaBillRawData[] = [];

      if (Array.isArray(data)) {
        // Normalize billinfo_list fields to RadaBillRawData format:
        //   billinfo_list uses: id, name, registrationNumber, registrationDate (ISO with T), subject
        //   RadaBillRawData expects: bill_id, number, title, registrationDate (YYYY-MM-DD), subject
        bills = data.map((item: any) => ({
          bill_id: item.id || item.bill_id,
          number: item.registrationNumber || item.number,
          title: item.name || item.title,
          name: item.name,
          registrationDate: item.registrationDate ? item.registrationDate.split('T')[0] : undefined,
          registrationSession: item.registrationSession,
          registrationConvocation: item.registrationConvocation,
          subject: item.subject,
          type: item.type,
          rubric: item.rubric,
          currentPhase_title: item.currentPhase?.title || item.currentPhase_title,
          currentPhase_date: item.currentPhase?.date || item.currentPhase_date,
          status: item.currentPhase?.status || item.status,
          url: item.url,
        }));
      } else if (data.bills && Array.isArray(data.bills)) {
        bills = data.bills;
      } else if (data.zpr && Array.isArray(data.zpr)) {
        bills = data.zpr;
      }

      logger.info('Bills fetched from API', { totalCount: bills.length });

      // Apply date filters if provided
      if (filters?.dateFrom || filters?.dateTo) {
        bills = bills.filter((bill) => {
          const dateStr = bill.registrationDate || bill.reg_date;
          if (!dateStr) return true;
          const billDate = new Date(dateStr);
          if (filters.dateFrom && billDate < new Date(filters.dateFrom)) return false;
          if (filters.dateTo && billDate > new Date(filters.dateTo)) return false;
          return true;
        });
        logger.info('Bills after date filter', { filteredCount: bills.length, dateFrom: filters?.dateFrom, dateTo: filters?.dateTo });
      }

      return bills;
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to fetch bills: ${error.message}`;
      logger.error(message, { statusCode, endpoint });
      throw new RadaAPIError(message, statusCode, endpoint);
    }
  }

  /**
   * Fetch voting records for a specific date.
   * RADA endpoint: /ogd/zal/ppz/skl{N}/json/DDMMYYYY.json
   */
  async fetchVoting(date: string, convocation: number = 9): Promise<RadaVotingRawData[]> {
    await this.waitForRateLimit();

    // Date format: YYYY-MM-DD -> convert to DDMMYYYY (RADA format)
    const [year, month, day] = date.split('-');
    const dateStr = `${day}${month}${year}`;
    const endpoint = `/ogd/zal/ppz/skl${convocation}/json/${dateStr}.json`;
    logger.info('Fetching voting records', { date, convocation, endpoint });

    try {
      const response = await this.client.get(endpoint);
      const data = response.data;

      // Response format: { question: [...] } — each question has event_question array
      if (data.question && Array.isArray(data.question)) {
        return data.question;
      } else if (Array.isArray(data)) {
        return data;
      } else if (data.questions && Array.isArray(data.questions)) {
        return data.questions;
      }

      logger.warn('Unexpected data format for voting', { date, convocation, keys: Object.keys(data) });
      return [];
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to fetch voting for ${date}: ${error.message}`;
      logger.error(message, { statusCode, endpoint });
      throw new RadaAPIError(message, statusCode, endpoint);
    }
  }

  /**
   * Fetch the list of dates that have plenary session data available.
   * Returns dates in YYYY-MM-DD format.
   */
  async fetchAvailableSessionDates(convocation: number = 9): Promise<string[]> {
    await this.waitForRateLimit();

    const endpoint = `/ogd/zal/ppz/skl${convocation}/dict/dates.txt`;
    logger.info('Fetching available session dates', { convocation });

    try {
      const response = await this.client.get(endpoint, { responseType: 'text' });
      const text = typeof response.data === 'string' ? response.data : String(response.data);

      // dates.txt has DD.MM.YYYY format, one per line
      return text
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => /^\d{2}\.\d{2}\.\d{4}$/.test(line))
        .map((line: string) => {
          const [d, m, y] = line.split('.');
          return `${y}-${m}-${d}`;
        });
    } catch (error: any) {
      logger.error('Failed to fetch available session dates', { error: error.message });
      return [];
    }
  }

  /**
   * Fetch factions (фракції) for a convocation.
   * Extracted from mps-data.json fr_associations where is_fr === 1.
   * The RADA API does not provide a standalone factions.json endpoint.
   */
  async fetchFactions(convocation: number = 9): Promise<RadaFactionRawData[]> {
    const endpoint = `/ogd/mps/skl${convocation}/mps-data.json (fr_associations)`;
    logger.info(`Fetching factions for convocation ${convocation}`);

    try {
      const mpsData = await this.fetchMpsData(convocation);

      // Factions are in fr_associations with is_fr === 1
      if (mpsData.fr_associations && Array.isArray(mpsData.fr_associations)) {
        const factions = mpsData.fr_associations.filter(
          (fr: any) => fr.is_fr === 1
        );
        logger.info(`Found ${factions.length} factions in mps-data.json`, { convocation });
        return factions;
      }

      logger.warn('No fr_associations found in mps-data.json', { convocation });
      return [];
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to fetch factions: ${error.message}`;
      logger.error(message, { statusCode, endpoint });
      throw new RadaAPIError(message, statusCode, endpoint);
    }
  }

  /**
   * Fetch committees (комітети) for a convocation.
   * Extracted from mps-data.json fr_associations where type === 2.
   * The RADA API does not provide a standalone committees.json endpoint.
   */
  async fetchCommittees(convocation: number = 9): Promise<any[]> {
    const endpoint = `/ogd/mps/skl${convocation}/mps-data.json (fr_associations)`;
    logger.info(`Fetching committees for convocation ${convocation}`);

    try {
      const mpsData = await this.fetchMpsData(convocation);

      // Committees are in fr_associations with type === 2
      if (mpsData.fr_associations && Array.isArray(mpsData.fr_associations)) {
        const committees = mpsData.fr_associations.filter(
          (fr: any) => fr.type === 2
        );
        logger.info(`Found ${committees.length} committees in mps-data.json`, { convocation });
        return committees;
      }

      logger.warn('No fr_associations found in mps-data.json', { convocation });
      return [];
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to fetch committees: ${error.message}`;
      logger.error(message, { statusCode, endpoint });
      throw new RadaAPIError(message, statusCode, endpoint);
    }
  }

  /**
   * Fetch deputy assistants.
   * Extracted from mps-data.json — each deputy's record contains an
   * "assistants" array. The standalone mps-assistants.json does not exist.
   */
  async fetchDeputyAssistants(radaId: string, convocation: number = 9): Promise<any[]> {
    logger.info('Fetching deputy assistants', { radaId, convocation });

    try {
      const mpsData = await this.fetchMpsData(convocation);
      const deputies = mpsData.mps || [];

      // Find the deputy by rada_id or id
      const deputy = deputies.find(
        (d: any) => String(d.rada_id) === String(radaId) || String(d.id) === String(radaId)
      );

      if (deputy && Array.isArray(deputy.assistants)) {
        logger.info(`Found ${deputy.assistants.length} assistants for deputy ${radaId}`);
        return deputy.assistants;
      }

      logger.debug('No assistants found for deputy', { radaId });
      return [];
    } catch (error: any) {
      const message = `Failed to fetch assistants: ${error.message}`;
      logger.error(message, { radaId, convocation });
      // Don't throw - assistants are optional
      return [];
    }
  }

  /**
   * List available datasets
   */
  async listDatasets(): Promise<any[]> {
    await this.waitForRateLimit();

    const endpoint = '/ogd/list.json';
    logger.info('Listing RADA datasets');

    try {
      const response = await this.client.get(endpoint);
      return response.data || [];
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to list datasets: ${error.message}`;
      logger.error(message, { statusCode, endpoint });
      throw new RadaAPIError(message, statusCode, endpoint);
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.get('/ogd/list.json');
      return true;
    } catch (error) {
      logger.error('RADA API health check failed:', error);
      return false;
    }
  }
}
