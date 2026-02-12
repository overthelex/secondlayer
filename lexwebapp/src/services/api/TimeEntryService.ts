/**
 * Time Entry Service
 * Handles time tracking and timer operations via /api/time
 */

import { BaseService } from '../base/BaseService';
import {
  TimeEntry,
  ActiveTimer,
  UserBillingRate,
  CreateTimeEntryParams,
  UpdateTimeEntryParams,
  TimeEntryFilters,
} from '../../types/models';

export interface TimeEntriesListResponse {
  entries: TimeEntry[];
  total: number;
}

export interface ActiveTimersResponse {
  timers: ActiveTimer[];
}

export interface StopTimerResponse {
  timer: ActiveTimer;
  timeEntry?: TimeEntry;
}

export interface UserRateResponse {
  hourly_rate_usd: number;
}

export interface UserRatesHistoryResponse {
  rates: UserBillingRate[];
}

export class TimeEntryService extends BaseService {
  /**
   * List time entries with optional filters
   */
  async getTimeEntries(filters?: TimeEntryFilters): Promise<TimeEntriesListResponse> {
    try {
      const response = await this.client.get<TimeEntriesListResponse>('/api/time/entries', {
        params: filters,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Create new time entry
   */
  async createTimeEntry(data: CreateTimeEntryParams): Promise<TimeEntry> {
    try {
      const response = await this.client.post<TimeEntry>('/api/time/entries', data);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Update time entry
   */
  async updateTimeEntry(id: string, data: UpdateTimeEntryParams): Promise<TimeEntry> {
    try {
      const response = await this.client.put<TimeEntry>(`/api/time/entries/${id}`, data);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Delete time entry
   */
  async deleteTimeEntry(id: string): Promise<void> {
    try {
      await this.client.delete(`/api/time/entries/${id}`);
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Submit time entry for approval
   */
  async submitTimeEntry(id: string): Promise<TimeEntry> {
    try {
      const response = await this.client.post<TimeEntry>(`/api/time/entries/${id}/submit`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Approve time entry
   */
  async approveTimeEntry(id: string): Promise<TimeEntry> {
    try {
      const response = await this.client.post<TimeEntry>(`/api/time/entries/${id}/approve`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Reject time entry
   */
  async rejectTimeEntry(id: string, notes?: string): Promise<TimeEntry> {
    try {
      const response = await this.client.post<TimeEntry>(`/api/time/entries/${id}/reject`, {
        notes,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ============================================================================
  // Timer Methods
  // ============================================================================

  /**
   * Start timer for a matter
   */
  async startTimer(matter_id: string, description?: string): Promise<ActiveTimer> {
    try {
      const response = await this.client.post<ActiveTimer>('/api/time/timers/start', {
        matter_id,
        description,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Stop timer and optionally create time entry
   */
  async stopTimer(matter_id: string, create_entry: boolean = true): Promise<StopTimerResponse> {
    try {
      const response = await this.client.post<StopTimerResponse>('/api/time/timers/stop', {
        matter_id,
        create_entry,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Get active timers for current user
   */
  async getActiveTimers(): Promise<ActiveTimer[]> {
    try {
      const response = await this.client.get<ActiveTimersResponse>('/api/time/timers/active');
      return response.data.timers;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Ping timer to keep it alive
   */
  async pingTimer(matter_id: string): Promise<void> {
    try {
      await this.client.post('/api/time/timers/ping', { matter_id });
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ============================================================================
  // Billing Rate Methods
  // ============================================================================

  /**
   * Get user's current billing rate
   */
  async getUserRate(userId: string, date?: string): Promise<number> {
    try {
      const response = await this.client.get<UserRateResponse>(`/api/time/rates/${userId}`, {
        params: { date },
      });
      return response.data.hourly_rate_usd;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Set user billing rate
   */
  async setUserRate(
    user_id: string,
    hourly_rate_usd: number,
    effective_from?: string,
    effective_to?: string,
    is_default?: boolean
  ): Promise<UserBillingRate> {
    try {
      const response = await this.client.post<UserBillingRate>('/api/time/rates', {
        user_id,
        hourly_rate_usd,
        effective_from,
        effective_to,
        is_default,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Get user's billing rate history
   */
  async getUserRateHistory(userId: string): Promise<UserBillingRate[]> {
    try {
      const response = await this.client.get<UserRatesHistoryResponse>(
        `/api/time/rates/${userId}/history`
      );
      return response.data.rates;
    } catch (error) {
      return this.handleError(error);
    }
  }
}

// Export singleton instance
export const timeEntryService = new TimeEntryService();
