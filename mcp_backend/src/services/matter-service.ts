import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { AuditService } from './audit-service.js';

export interface Client {
  id: string;
  organization_id: string;
  client_name: string;
  client_type: 'individual' | 'business' | 'government';
  contact_email?: string;
  tax_id?: string;
  status: 'active' | 'inactive' | 'archived';
  conflict_check_date?: Date;
  conflict_status: 'unchecked' | 'clear' | 'flagged' | 'conflicted';
  metadata?: any;
  created_at: Date;
  created_by?: string;
}

export interface Matter {
  id: string;
  client_id: string;
  matter_number: string;
  matter_name: string;
  matter_type?: string;
  status: 'open' | 'active' | 'closed' | 'archived';
  opened_date: Date;
  closed_date?: Date;
  responsible_attorney?: string;
  opposing_party?: string;
  court_case_number?: string;
  court_name?: string;
  related_parties?: any[];
  retention_period_years: number;
  legal_hold: boolean;
  metadata?: any;
  created_at: Date;
  created_by?: string;
}

export interface MatterTeamMember {
  id: string;
  matter_id: string;
  user_id: string;
  role: 'lead_attorney' | 'associate' | 'paralegal' | 'assistant' | 'observer';
  access_level: 'full' | 'read-only' | 'limited';
  added_at: Date;
  added_by?: string;
  removed_at?: Date;
  // Joined fields
  user_name?: string;
  user_email?: string;
}

export class MatterService {
  constructor(
    private db: Database,
    private auditService: AuditService
  ) {}

  // ─── Client CRUD ───────────────────────────────────────────

  async createClient(
    orgId: string,
    data: {
      clientName: string;
      clientType?: string;
      contactEmail?: string;
      taxId?: string;
      metadata?: any;
    },
    createdBy: string
  ): Promise<Client> {
    const id = uuidv4();
    const result = await this.db.query(
      `INSERT INTO clients (id, organization_id, client_name, client_type, contact_email, tax_id, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id, orgId, data.clientName, data.clientType || 'individual',
        data.contactEmail || null, data.taxId || null,
        JSON.stringify(data.metadata || {}), createdBy,
      ]
    );

    await this.auditService.log({
      userId: createdBy,
      action: 'client.create',
      resourceType: 'client',
      resourceId: id,
      details: { clientName: data.clientName, organizationId: orgId },
    });

    return result.rows[0];
  }

  async updateClient(
    clientId: string,
    data: Partial<{
      clientName: string;
      clientType: string;
      contactEmail: string;
      taxId: string;
      status: string;
      metadata: any;
    }>,
    userId: string
  ): Promise<Client | null> {
    const sets: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (data.clientName !== undefined) { sets.push(`client_name = $${paramIndex++}`); params.push(data.clientName); }
    if (data.clientType !== undefined) { sets.push(`client_type = $${paramIndex++}`); params.push(data.clientType); }
    if (data.contactEmail !== undefined) { sets.push(`contact_email = $${paramIndex++}`); params.push(data.contactEmail); }
    if (data.taxId !== undefined) { sets.push(`tax_id = $${paramIndex++}`); params.push(data.taxId); }
    if (data.status !== undefined) { sets.push(`status = $${paramIndex++}`); params.push(data.status); }
    if (data.metadata !== undefined) { sets.push(`metadata = $${paramIndex++}`); params.push(JSON.stringify(data.metadata)); }

    if (sets.length === 0) return null;

    params.push(clientId);
    const result = await this.db.query(
      `UPDATE clients SET ${sets.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (result.rows.length === 0) return null;

    await this.auditService.log({
      userId,
      action: 'client.update',
      resourceType: 'client',
      resourceId: clientId,
      details: { updatedFields: Object.keys(data) },
    });

    return result.rows[0];
  }

  async getClient(clientId: string, orgId: string): Promise<Client | null> {
    const result = await this.db.query(
      `SELECT * FROM clients WHERE id = $1 AND organization_id = $2`,
      [clientId, orgId]
    );
    return result.rows[0] || null;
  }

  async listClients(
    orgId: string,
    filters: { status?: string; search?: string; limit?: number; offset?: number } = {}
  ): Promise<{ clients: Client[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = ['organization_id = $1'];
    const params: any[] = [orgId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }
    if (filters.search) {
      conditions.push(`client_name ILIKE $${paramIndex++}`);
      params.push(`%${filters.search}%`);
    }

    const where = conditions.join(' AND ');

    const [result, countResult] = await Promise.all([
      this.db.query(
        `SELECT * FROM clients WHERE ${where} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM clients WHERE ${where}`, params),
    ]);

    return {
      clients: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  // ─── Matter CRUD ───────────────────────────────────────────

  async createMatter(
    data: {
      clientId: string;
      matterName: string;
      matterType?: string;
      responsibleAttorney?: string;
      opposingParty?: string;
      courtCaseNumber?: string;
      courtName?: string;
      relatedParties?: any[];
      retentionPeriodYears?: number;
      metadata?: any;
    },
    createdBy: string
  ): Promise<Matter> {
    const id = uuidv4();
    const matterNumber = await this.generateMatterNumber(data.clientId);

    return await this.db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO matters (id, client_id, matter_number, matter_name, matter_type,
          responsible_attorney, opposing_party, court_case_number, court_name,
          related_parties, retention_period_years, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          id, data.clientId, matterNumber, data.matterName, data.matterType || null,
          data.responsibleAttorney || createdBy, data.opposingParty || null,
          data.courtCaseNumber || null, data.courtName || null,
          JSON.stringify(data.relatedParties || []),
          data.retentionPeriodYears || 7,
          JSON.stringify(data.metadata || {}), createdBy,
        ]
      );

      // Add creator as lead_attorney
      await client.query(
        `INSERT INTO matter_team (id, matter_id, user_id, role, access_level, added_by)
         VALUES ($1, $2, $3, 'lead_attorney', 'full', $3)`,
        [uuidv4(), id, createdBy]
      );

      await this.auditService.log({
        userId: createdBy,
        action: 'matter.create',
        resourceType: 'matter',
        resourceId: id,
        details: { matterNumber, matterName: data.matterName, clientId: data.clientId },
      });

      return result.rows[0];
    });
  }

  async updateMatter(
    matterId: string,
    data: Partial<{
      matterName: string;
      matterType: string;
      responsibleAttorney: string;
      opposingParty: string;
      courtCaseNumber: string;
      courtName: string;
      relatedParties: any[];
      retentionPeriodYears: number;
      metadata: any;
    }>,
    userId: string
  ): Promise<Matter | null> {
    const sets: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (data.matterName !== undefined) { sets.push(`matter_name = $${paramIndex++}`); params.push(data.matterName); }
    if (data.matterType !== undefined) { sets.push(`matter_type = $${paramIndex++}`); params.push(data.matterType); }
    if (data.responsibleAttorney !== undefined) { sets.push(`responsible_attorney = $${paramIndex++}`); params.push(data.responsibleAttorney); }
    if (data.opposingParty !== undefined) { sets.push(`opposing_party = $${paramIndex++}`); params.push(data.opposingParty); }
    if (data.courtCaseNumber !== undefined) { sets.push(`court_case_number = $${paramIndex++}`); params.push(data.courtCaseNumber); }
    if (data.courtName !== undefined) { sets.push(`court_name = $${paramIndex++}`); params.push(data.courtName); }
    if (data.relatedParties !== undefined) { sets.push(`related_parties = $${paramIndex++}`); params.push(JSON.stringify(data.relatedParties)); }
    if (data.retentionPeriodYears !== undefined) { sets.push(`retention_period_years = $${paramIndex++}`); params.push(data.retentionPeriodYears); }
    if (data.metadata !== undefined) { sets.push(`metadata = $${paramIndex++}`); params.push(JSON.stringify(data.metadata)); }

    if (sets.length === 0) return null;

    params.push(matterId);
    const result = await this.db.query(
      `UPDATE matters SET ${sets.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (result.rows.length === 0) return null;

    await this.auditService.log({
      userId,
      action: 'matter.update',
      resourceType: 'matter',
      resourceId: matterId,
      details: { updatedFields: Object.keys(data) },
    });

    return result.rows[0];
  }

  async getMatter(matterId: string, userId: string): Promise<Matter | null> {
    // Check access: user must be on matter_team or be org admin/owner
    const result = await this.db.query(
      `SELECT m.* FROM matters m
       WHERE m.id = $1
       AND (
         EXISTS (SELECT 1 FROM matter_team mt WHERE mt.matter_id = m.id AND mt.user_id = $2 AND mt.removed_at IS NULL)
         OR EXISTS (
           SELECT 1 FROM organization_members om
           JOIN clients c ON c.organization_id = om.organization_id
           WHERE c.id = m.client_id AND om.user_id = $2 AND om.role IN ('owner', 'admin')
         )
       )`,
      [matterId, userId]
    );
    return result.rows[0] || null;
  }

  async listMatters(
    orgId: string,
    userId: string,
    filters: { status?: string; clientId?: string; search?: string; limit?: number; offset?: number } = {}
  ): Promise<{ matters: Matter[]; total: number }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions = ['c.organization_id = $1'];
    const params: any[] = [orgId];
    let paramIndex = 2;

    // Access check: user must be on team or org admin
    conditions.push(
      `(EXISTS (SELECT 1 FROM matter_team mt WHERE mt.matter_id = m.id AND mt.user_id = $${paramIndex} AND mt.removed_at IS NULL)
        OR EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id = $1 AND om.user_id = $${paramIndex} AND om.role IN ('owner', 'admin')))`
    );
    params.push(userId);
    paramIndex++;

    if (filters.status) {
      conditions.push(`m.status = $${paramIndex++}`);
      params.push(filters.status);
    }
    if (filters.clientId) {
      conditions.push(`m.client_id = $${paramIndex++}`);
      params.push(filters.clientId);
    }
    if (filters.search) {
      conditions.push(`(m.matter_name ILIKE $${paramIndex} OR m.matter_number ILIKE $${paramIndex})`);
      params.push(`%${filters.search}%`);
      paramIndex++;
    }

    const where = conditions.join(' AND ');

    const [result, countResult] = await Promise.all([
      this.db.query(
        `SELECT m.* FROM matters m
         JOIN clients c ON c.id = m.client_id
         WHERE ${where}
         ORDER BY m.created_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      ),
      this.db.query(
        `SELECT COUNT(*) FROM matters m JOIN clients c ON c.id = m.client_id WHERE ${where}`,
        params
      ),
    ]);

    return {
      matters: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  async closeMatter(matterId: string, userId: string): Promise<Matter | null> {
    const result = await this.db.query(
      `UPDATE matters SET status = 'closed', closed_date = NOW() WHERE id = $1 RETURNING *`,
      [matterId]
    );

    if (result.rows.length === 0) return null;

    await this.auditService.log({
      userId,
      action: 'matter.close',
      resourceType: 'matter',
      resourceId: matterId,
    });

    return result.rows[0];
  }

  // ─── Team Management ───────────────────────────────────────

  async addTeamMember(
    matterId: string,
    userId: string,
    role: string,
    accessLevel: string,
    addedBy: string
  ): Promise<MatterTeamMember> {
    const id = uuidv4();
    const result = await this.db.query(
      `INSERT INTO matter_team (id, matter_id, user_id, role, access_level, added_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (matter_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         access_level = EXCLUDED.access_level,
         removed_at = NULL,
         added_by = EXCLUDED.added_by,
         added_at = NOW()
       RETURNING *`,
      [id, matterId, userId, role, accessLevel, addedBy]
    );

    await this.auditService.log({
      userId: addedBy,
      action: 'matter.team.add',
      resourceType: 'matter',
      resourceId: matterId,
      details: { addedUserId: userId, role, accessLevel },
    });

    return result.rows[0];
  }

  async removeTeamMember(matterId: string, userId: string, removedBy: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE matter_team SET removed_at = NOW() WHERE matter_id = $1 AND user_id = $2 AND removed_at IS NULL RETURNING id`,
      [matterId, userId]
    );

    if (result.rows.length > 0) {
      await this.auditService.log({
        userId: removedBy,
        action: 'matter.team.remove',
        resourceType: 'matter',
        resourceId: matterId,
        details: { removedUserId: userId },
      });
    }

    return result.rows.length > 0;
  }

  async getTeamMembers(matterId: string): Promise<MatterTeamMember[]> {
    const result = await this.db.query(
      `SELECT mt.*, u.name as user_name, u.email as user_email
       FROM matter_team mt
       JOIN users u ON u.id = mt.user_id
       WHERE mt.matter_id = $1 AND mt.removed_at IS NULL
       ORDER BY mt.added_at`,
      [matterId]
    );
    return result.rows;
  }

  async isUserOnMatter(matterId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM matter_team
       WHERE matter_id = $1 AND user_id = $2 AND removed_at IS NULL
       LIMIT 1`,
      [matterId, userId]
    );
    return result.rows.length > 0;
  }

  // ─── Helpers ───────────────────────────────────────────────

  async getUserOrgId(userId: string): Promise<string | null> {
    const result = await this.db.query(
      `SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    return result.rows[0]?.organization_id || null;
  }

  async isOrgAdmin(orgId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM organization_members
       WHERE organization_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')
       LIMIT 1`,
      [orgId, userId]
    );
    return result.rows.length > 0;
  }

  private async generateMatterNumber(clientId: string): Promise<string> {
    // Format: CLT-XXX-YYYY-NNN
    const year = new Date().getFullYear();

    // Get client short code (first 3 chars of name uppercased)
    const clientResult = await this.db.query(
      `SELECT client_name FROM clients WHERE id = $1`,
      [clientId]
    );
    const clientName = clientResult.rows[0]?.client_name || 'UNK';
    const code = clientName.replace(/[^A-Za-z]/g, '').substring(0, 3).toUpperCase().padEnd(3, 'X');

    // Get next sequence number for this client this year
    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM matters
       WHERE client_id = $1 AND EXTRACT(YEAR FROM created_at) = $2`,
      [clientId, year]
    );
    const seq = (parseInt(countResult.rows[0].count, 10) + 1).toString().padStart(3, '0');

    return `${code}-${year}-${seq}`;
  }
}
