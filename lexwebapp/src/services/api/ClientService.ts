/**
 * Client Service
 * Handles client management operations via /api/matters/clients
 */

import { BaseService } from '../base/BaseService';
import { Client, CreateClientRequest, UpdateClientRequest, ClientsListResponse } from '../../types/models';

export interface SearchClientsParams {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export class ClientService extends BaseService {
  /**
   * List clients with optional filters
   */
  async getClients(params?: SearchClientsParams): Promise<ClientsListResponse> {
    try {
      const response = await this.client.get<ClientsListResponse>('/api/matters/clients', {
        params,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Get client by ID
   */
  async getClientById(id: string): Promise<Client> {
    try {
      const response = await this.client.get<Client>(`/api/matters/clients/${id}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Create new client
   */
  async createClient(data: CreateClientRequest): Promise<Client> {
    try {
      const response = await this.client.post<Client>('/api/matters/clients', data);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Update client
   */
  async updateClient(id: string, data: UpdateClientRequest): Promise<Client> {
    try {
      const response = await this.client.put<Client>(
        `/api/matters/clients/${id}`,
        data
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Run conflict check for a client
   */
  async runConflictCheck(id: string): Promise<any> {
    try {
      const response = await this.client.post(`/api/matters/clients/${id}/conflict-check`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }
}

// Export singleton instance
export const clientService = new ClientService();
