/**
 * Client Service
 * Handles client management operations
 */

import { BaseService } from '../base/BaseService';
import { Client, ClientDetail } from '../../types/models';
import { ListResponse } from '../../types/api';

export interface CreateClientRequest {
  name: string;
  company: string;
  email: string;
  phone: string;
  type: 'individual' | 'corporate';
  address?: string;
  notes?: string;
}

export interface UpdateClientRequest extends Partial<CreateClientRequest> {
  status?: 'active' | 'inactive';
}

export interface SearchClientsRequest {
  query?: string;
  type?: 'individual' | 'corporate' | 'all';
  status?: 'active' | 'inactive' | 'all';
  limit?: number;
  offset?: number;
}

export class ClientService extends BaseService {
  /**
   * Get all clients
   */
  async getClients(params?: SearchClientsRequest): Promise<ListResponse<Client>> {
    try {
      const response = await this.client.get<ListResponse<Client>>('/api/clients', {
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
  async getClientById(id: string): Promise<ClientDetail> {
    try {
      const response = await this.client.get<{ client: ClientDetail }>(
        `/api/clients/${id}`
      );
      return response.data.client;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Create new client
   */
  async createClient(data: CreateClientRequest): Promise<Client> {
    try {
      const response = await this.client.post<{ client: Client }>('/api/clients', data);
      return response.data.client;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Update client
   */
  async updateClient(id: string, data: UpdateClientRequest): Promise<Client> {
    try {
      const response = await this.client.put<{ client: Client }>(
        `/api/clients/${id}`,
        data
      );
      return response.data.client;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Delete client
   */
  async deleteClient(id: string): Promise<void> {
    try {
      await this.client.delete(`/api/clients/${id}`);
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Send message to clients
   */
  async sendMessage(clientIds: string[], message: string): Promise<void> {
    try {
      await this.client.post('/api/clients/message', {
        client_ids: clientIds,
        message,
      });
    } catch (error) {
      return this.handleError(error);
    }
  }
}

// Export singleton instance
export const clientService = new ClientService();
