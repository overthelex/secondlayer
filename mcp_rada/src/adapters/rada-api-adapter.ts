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
  private minRequestInterval: number = 500; // 500ms between requests
  private _costTracker?: CostTracker;

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
   * Fetch deputies for a given convocation (скликання)
   * Default: convocation 9 (current)
   */
  async fetchDeputies(convocation: number = 9): Promise<RadaDeputyRawData[]> {
    await this.waitForRateLimit();

    const endpoint = `/ogd/mps/skl${convocation}/mps-data.json`;
    logger.info(`Fetching deputies for convocation ${convocation}`);

    try {
      const response = await this.client.get(endpoint);
      const data = response.data;

      // Response can be array directly or object with mps_list
      if (Array.isArray(data)) {
        return data;
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
   * Note: RADA API may have multiple endpoints for bills data
   */
  async fetchBills(filters?: { dateFrom?: string; dateTo?: string; convocation?: number }): Promise<RadaBillRawData[]> {
    await this.waitForRateLimit();

    const convocation = filters?.convocation || 9;
    const endpoint = `/ogd/zpr/skl${convocation}/bills-main.json`;
    logger.info('Fetching bills', { convocation, filters });

    try {
      const response = await this.client.get(endpoint);
      const data = response.data;

      // Response can be array or object with bills array
      let bills: RadaBillRawData[] = [];

      if (Array.isArray(data)) {
        bills = data;
      } else if (data.bills && Array.isArray(data.bills)) {
        bills = data.bills;
      } else if (data.zpr && Array.isArray(data.zpr)) {
        bills = data.zpr;
      }

      // Apply date filters if provided
      if (filters?.dateFrom || filters?.dateTo) {
        bills = bills.filter((bill) => {
          if (!bill.reg_date) return true;
          const billDate = new Date(bill.reg_date);
          if (filters.dateFrom && billDate < new Date(filters.dateFrom)) return false;
          if (filters.dateTo && billDate > new Date(filters.dateTo)) return false;
          return true;
        });
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
   * Fetch voting records for a specific date
   */
  async fetchVoting(date: string, convocation: number = 9): Promise<RadaVotingRawData[]> {
    await this.waitForRateLimit();

    // Date format: YYYY-MM-DD -> convert to YYYYMMDD
    const dateStr = date.replace(/-/g, '');
    const endpoint = `/ogd/zal/skl${convocation}/plenary/${dateStr}.json`;
    logger.info('Fetching voting records', { date, convocation });

    try {
      const response = await this.client.get(endpoint);
      const data = response.data;

      // Response can be array or object with questions array
      if (Array.isArray(data)) {
        return data;
      } else if (data.questions && Array.isArray(data.questions)) {
        return data.questions;
      } else if (data.voting && Array.isArray(data.voting)) {
        return data.voting;
      }

      logger.warn('Unexpected data format for voting', { date, convocation });
      return [];
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to fetch voting for ${date}: ${error.message}`;
      logger.error(message, { statusCode, endpoint });
      throw new RadaAPIError(message, statusCode, endpoint);
    }
  }

  /**
   * Fetch factions (фракції) for a convocation
   */
  async fetchFactions(convocation: number = 9): Promise<RadaFactionRawData[]> {
    await this.waitForRateLimit();

    const endpoint = `/ogd/mps/skl${convocation}/factions.json`;
    logger.info(`Fetching factions for convocation ${convocation}`);

    try {
      const response = await this.client.get(endpoint);
      const data = response.data;

      // Response can be array or object with factions array
      if (Array.isArray(data)) {
        return data;
      } else if (data.factions && Array.isArray(data.factions)) {
        return data.factions;
      } else if (data.fr_list && Array.isArray(data.fr_list)) {
        return data.fr_list;
      }

      logger.warn('Unexpected data format for factions', { convocation });
      return [];
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to fetch factions: ${error.message}`;
      logger.error(message, { statusCode, endpoint });
      throw new RadaAPIError(message, statusCode, endpoint);
    }
  }

  /**
   * Fetch committees (комітети) for a convocation
   */
  async fetchCommittees(convocation: number = 9): Promise<any[]> {
    await this.waitForRateLimit();

    const endpoint = `/ogd/mps/skl${convocation}/committees.json`;
    logger.info(`Fetching committees for convocation ${convocation}`);

    try {
      const response = await this.client.get(endpoint);
      const data = response.data;

      // Response can be array or object with committees array
      if (Array.isArray(data)) {
        return data;
      } else if (data.committees && Array.isArray(data.committees)) {
        return data.committees;
      } else if (data.kom_list && Array.isArray(data.kom_list)) {
        return data.kom_list;
      }

      logger.warn('Unexpected data format for committees', { convocation });
      return [];
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to fetch committees: ${error.message}`;
      logger.error(message, { statusCode, endpoint });
      throw new RadaAPIError(message, statusCode, endpoint);
    }
  }

  /**
   * Fetch deputy assistants
   */
  async fetchDeputyAssistants(radaId: string, convocation: number = 9): Promise<any[]> {
    await this.waitForRateLimit();

    const endpoint = `/ogd/mps/skl${convocation}/mps-assistants.json`;
    logger.info('Fetching deputy assistants', { radaId, convocation });

    try {
      const response = await this.client.get(endpoint);
      const data = response.data;

      let assistants: any[] = [];

      if (Array.isArray(data)) {
        assistants = data;
      } else if (data.assistants && Array.isArray(data.assistants)) {
        assistants = data.assistants;
      }

      // Filter by deputy ID
      return assistants.filter((a) => a.mps_id === radaId || a.deputy_id === radaId);
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to fetch assistants: ${error.message}`;
      logger.error(message, { statusCode, endpoint });
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
