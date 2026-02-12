/**
 * Matter Service
 * Handles matter, team, hold, and audit operations via /api/matters
 */

import { BaseService } from '../base/BaseService';
import {
  Matter,
  CreateMatterRequest,
  UpdateMatterRequest,
  MattersListResponse,
  MatterTeamMember,
  MatterTeamRole,
  MatterAccessLevel,
  LegalHold,
  CreateHoldRequest,
  AuditLogResponse,
  AuditValidationResult,
} from '../../types/models/Matter';

export interface SearchMattersParams {
  search?: string;
  status?: string;
  clientId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogParams {
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export class MatterService extends BaseService {
  // ─── Matters ───────────────────────────────────────────

  async getMatters(params?: SearchMattersParams): Promise<MattersListResponse> {
    try {
      const response = await this.client.get<MattersListResponse>('/api/matters/matters', {
        params,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getMatterById(id: string): Promise<Matter> {
    try {
      const response = await this.client.get<Matter>(`/api/matters/matters/${id}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async createMatter(data: CreateMatterRequest): Promise<Matter> {
    try {
      const response = await this.client.post<Matter>('/api/matters/matters', data);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async updateMatter(id: string, data: UpdateMatterRequest): Promise<Matter> {
    try {
      const response = await this.client.put<Matter>(`/api/matters/matters/${id}`, data);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async closeMatter(id: string): Promise<Matter> {
    try {
      const response = await this.client.post<Matter>(`/api/matters/matters/${id}/close`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ─── Team ──────────────────────────────────────────────

  async getTeamMembers(matterId: string): Promise<{ members: MatterTeamMember[] }> {
    try {
      const response = await this.client.get<{ members: MatterTeamMember[] }>(
        `/api/matters/matters/${matterId}/team`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async addTeamMember(
    matterId: string,
    memberId: string,
    role: MatterTeamRole = 'associate',
    accessLevel: MatterAccessLevel = 'full'
  ): Promise<MatterTeamMember> {
    try {
      const response = await this.client.post<MatterTeamMember>(
        `/api/matters/matters/${matterId}/team`,
        { memberId, role, accessLevel }
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async removeTeamMember(matterId: string, userId: string): Promise<void> {
    try {
      await this.client.delete(`/api/matters/matters/${matterId}/team/${userId}`);
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ─── Legal Holds ───────────────────────────────────────

  async getHolds(matterId: string): Promise<{ holds: LegalHold[] }> {
    try {
      const response = await this.client.get<{ holds: LegalHold[] }>(
        `/api/matters/matters/${matterId}/holds`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async createHold(matterId: string, data: CreateHoldRequest): Promise<LegalHold> {
    try {
      const response = await this.client.post<LegalHold>(
        `/api/matters/matters/${matterId}/holds`,
        data
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async releaseHold(holdId: string): Promise<LegalHold> {
    try {
      const response = await this.client.post<LegalHold>(
        `/api/matters/holds/${holdId}/release`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async addDocumentsToHold(holdId: string, documentIds: string[]): Promise<any> {
    try {
      const response = await this.client.post(
        `/api/matters/holds/${holdId}/documents`,
        { documentIds }
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ─── Audit ─────────────────────────────────────────────

  async getAuditLog(params?: AuditLogParams): Promise<AuditLogResponse> {
    try {
      const response = await this.client.get<AuditLogResponse>('/api/matters/audit', {
        params,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async validateAuditChain(): Promise<AuditValidationResult> {
    try {
      const response = await this.client.get<AuditValidationResult>(
        '/api/matters/audit/validate'
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }
}

// Export singleton instance
export const matterService = new MatterService();
