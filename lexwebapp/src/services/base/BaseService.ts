/**
 * Base Service
 * Abstract base class for all services with common error handling
 */

import { AxiosInstance, AxiosError } from 'axios';
import apiClient from '../../utils/api-client';

export interface ServiceError {
  code: string;
  message: string;
  status?: number;
  details?: any;
}

export abstract class BaseService {
  protected client: AxiosInstance;

  constructor(client?: AxiosInstance) {
    this.client = client || apiClient;
  }

  /**
   * Handle API errors uniformly across all services
   */
  protected handleError(error: unknown): never {
    if (error instanceof AxiosError) {
      const serviceError: ServiceError = {
        code: error.code || 'UNKNOWN_ERROR',
        message: error.response?.data?.message || error.message,
        status: error.response?.status,
        details: error.response?.data,
      };

      throw serviceError;
    }

    if (error instanceof Error) {
      throw {
        code: 'INTERNAL_ERROR',
        message: error.message,
      } as ServiceError;
    }

    throw {
      code: 'UNKNOWN_ERROR',
      message: 'An unknown error occurred',
    } as ServiceError;
  }

  /**
   * Parse JSON safely
   */
  protected safeJsonParse<T>(json: string, fallback: T): T {
    try {
      return JSON.parse(json);
    } catch {
      return fallback;
    }
  }
}
