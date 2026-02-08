/**
 * Team Service
 * Manages team operations including members, invitations, roles, and permissions
 */

import { BaseDatabase, logger } from '@secondlayer/shared';

export interface TeamMember {
  id: string;
  name: string;
  initials: string;
  email: string;
  role: 'owner' | 'admin' | 'user' | 'observer';
  requests: number | null;
  cost: string | null;
  lastActive: string;
  status: 'active' | 'inactive' | 'pending';
  avatarColor: 'blue' | 'green' | 'yellow' | 'purple' | 'red' | 'gray';
}

export interface TeamStats {
  totalMembers: number;
  activeUsers: number;
  teamRequests: number;
  teamCost: number;
}

export interface Organization {
  id: string;
  name: string;
  ownerId: string;
  plan: string;
  maxMembers: number;
  createdAt: Date;
}

export class TeamService {
  constructor(private db: BaseDatabase) {}

  /**
   * Get user's organization
   */
  async getOrganization(userId: string): Promise<Organization | null> {
    const result = await this.db.query(
      `SELECT id, name, owner_id as "ownerId", plan, max_members as "maxMembers", created_at as "createdAt"
       FROM organizations
       WHERE owner_id = $1`,
      [userId]
    );

    return result.rows[0] || null;
  }

  /**
   * Get or create default organization for user
   */
  async getOrCreateDefaultOrganization(userId: string, userName: string): Promise<Organization> {
    let org = await this.getOrganization(userId);

    if (!org) {
      const result = await this.db.query(
        `INSERT INTO organizations (name, owner_id, plan, max_members)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, owner_id as "ownerId", plan, max_members as "maxMembers", created_at as "createdAt"`,
        [`${userName}'s Workspace`, userId, 'free', 10]
      );
      org = result.rows[0] as Organization;
      logger.info(`Created default organization for user ${userId}`);
    }

    return org as Organization;
  }

  /**
   * Get team members for organization
   */
  async getTeamMembers(userId: string): Promise<TeamMember[]> {
    const org = await this.getOrganization(userId);

    if (!org) {
      return [];
    }

    const result = await this.db.query(
      `SELECT
        om.id,
        om.email,
        om.role,
        om.status,
        om.last_active as "lastActive",
        u.name,
        COALESCE(ct.request_count, 0) as "requests",
        COALESCE(ct.total_cost, '₴0') as "cost"
       FROM organization_members om
       LEFT JOIN users u ON om.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) as request_count,
           '₴' || ROUND(SUM(COALESCE(estimated_cost, 0))::numeric, 2)::text as total_cost
         FROM cost_tracking
         WHERE user_id = om.user_id
         AND DATE(created_at) >= CURRENT_DATE - INTERVAL '30 days'
       ) ct ON TRUE
       WHERE om.organization_id = $1
       ORDER BY om.joined_at DESC NULLS LAST, om.invited_at DESC`,
      [org.id]
    );

    return result.rows.map(row => ({
      id: row.id,
      name: row.name || row.email,
      initials: this.getInitials(row.name || row.email),
      email: row.email,
      role: row.role,
      status: row.status,
      requests: row.requests || null,
      cost: row.cost,
      lastActive: row.lastActive ? new Date(row.lastActive).toLocaleDateString('uk-UA') : 'Ніколи',
      avatarColor: this.getAvatarColor(row.email),
    }));
  }

  /**
   * Invite a new team member
   */
  async inviteMember(userId: string, email: string, role: 'admin' | 'user' | 'observer'): Promise<any> {
    const org = await this.getOrganization(userId);

    if (!org) {
      throw new Error('Organization not found');
    }

    // Check permissions - only owner and admin can invite
    const caller = await this.getUserRole(userId, org.id);
    if (caller !== 'owner' && caller !== 'admin') {
      throw new Error('Insufficient permissions to invite members');
    }

    // Check member limit
    const memberCount = await this.db.query(
      `SELECT COUNT(*) as count FROM organization_members WHERE organization_id = $1 AND status = 'active'`,
      [org.id]
    );

    if (memberCount.rows[0].count >= org.maxMembers) {
      throw new Error(`Organization has reached maximum members limit (${org.maxMembers})`);
    }

    // Check if already invited
    const existing = await this.db.query(
      `SELECT id FROM organization_members WHERE organization_id = $1 AND email = $2`,
      [org.id, email]
    );

    if (existing.rows.length > 0) {
      throw new Error('Member already invited');
    }

    // Create invitation
    const result = await this.db.query(
      `INSERT INTO organization_members (organization_id, email, role, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, email, role, invited_at as "invitedAt"`,
      [org.id, email, role]
    );

    logger.info(`Invited ${email} to organization ${org.id}`);

    // TODO: Send email invitation

    return result.rows[0];
  }

  /**
   * Update member role
   */
  async updateMemberRole(userId: string, memberId: string, newRole: string): Promise<void> {
    const org = await this.getOrganization(userId);

    if (!org) {
      throw new Error('Organization not found');
    }

    // Check permissions
    const caller = await this.getUserRole(userId, org.id);
    if (caller !== 'owner') {
      throw new Error('Only owner can change member roles');
    }

    // Get member details
    const member = await this.db.query(
      `SELECT organization_id FROM organization_members WHERE id = $1`,
      [memberId]
    );

    if (member.rows.length === 0 || member.rows[0].organization_id !== org.id) {
      throw new Error('Member not found');
    }

    await this.db.query(
      `UPDATE organization_members SET role = $1 WHERE id = $2`,
      [newRole, memberId]
    );

    logger.info(`Updated member ${memberId} role to ${newRole}`);
  }

  /**
   * Remove member from organization
   */
  async removeMember(userId: string, memberId: string): Promise<void> {
    const org = await this.getOrganization(userId);

    if (!org) {
      throw new Error('Organization not found');
    }

    // Check permissions
    const caller = await this.getUserRole(userId, org.id);
    if (caller !== 'owner') {
      throw new Error('Only owner can remove members');
    }

    // Get member details
    const member = await this.db.query(
      `SELECT organization_id, role FROM organization_members WHERE id = $1`,
      [memberId]
    );

    if (member.rows.length === 0 || member.rows[0].organization_id !== org.id) {
      throw new Error('Member not found');
    }

    if (member.rows[0].role === 'owner') {
      throw new Error('Cannot remove organization owner');
    }

    await this.db.query(
      `DELETE FROM organization_members WHERE id = $1`,
      [memberId]
    );

    logger.info(`Removed member ${memberId} from organization ${org.id}`);
  }

  /**
   * Resend invitation email
   */
  async resendInvitation(userId: string, memberId: string): Promise<void> {
    const org = await this.getOrganization(userId);

    if (!org) {
      throw new Error('Organization not found');
    }

    const member = await this.db.query(
      `SELECT email, status FROM organization_members WHERE id = $1 AND organization_id = $2`,
      [memberId, org.id]
    );

    if (member.rows.length === 0) {
      throw new Error('Member not found');
    }

    if (member.rows[0].status !== 'pending') {
      throw new Error('Can only resend invitation for pending members');
    }

    // TODO: Send email invitation

    logger.info(`Resent invitation to ${member.rows[0].email}`);
  }

  /**
   * Get team statistics
   */
  async getTeamStats(userId: string): Promise<TeamStats> {
    const org = await this.getOrganization(userId);

    if (!org) {
      return {
        totalMembers: 1,
        activeUsers: 1,
        teamRequests: 0,
        teamCost: 0,
      };
    }

    // Total members
    const membersResult = await this.db.query(
      `SELECT COUNT(*) as count FROM organization_members WHERE organization_id = $1 AND status = 'active'`,
      [org.id]
    );
    const totalMembers = parseInt(membersResult.rows[0].count) + 1; // +1 for owner

    // Active users (last 7 days)
    const activeResult = await this.db.query(
      `SELECT COUNT(DISTINCT user_id) as count
       FROM organization_members
       WHERE organization_id = $1 AND last_active >= NOW() - INTERVAL '7 days'`,
      [org.id]
    );
    const activeUsers = parseInt(activeResult.rows[0].count) + 1; // +1 for owner

    // Team requests and cost
    const statsResult = await this.db.query(
      `SELECT
        COUNT(*) as request_count,
        COALESCE(SUM(estimated_cost), 0) as total_cost
       FROM cost_tracking ct
       JOIN organization_members om ON ct.user_id = om.user_id
       WHERE om.organization_id = $1
       AND ct.created_at >= NOW() - INTERVAL '30 days'`,
      [org.id]
    );

    return {
      totalMembers,
      activeUsers,
      teamRequests: parseInt(statsResult.rows[0]?.request_count || 0),
      teamCost: Math.round(parseFloat(statsResult.rows[0]?.total_cost || 0)),
    };
  }

  /**
   * Private helper: Get user's role in organization
   */
  private async getUserRole(userId: string, orgId: string): Promise<string> {
    const org = await this.getOrganization(userId);
    if (org && org.id === orgId && org.ownerId === userId) {
      return 'owner';
    }

    const result = await this.db.query(
      `SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2`,
      [userId, orgId]
    );

    return result.rows[0]?.role || 'none';
  }

  /**
   * Private helper: Get initials from name/email
   */
  private getInitials(name: string): string {
    return name
      .split(' ')
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase())
      .filter(Boolean)
      .join('')
      .slice(0, 2);
  }

  /**
   * Private helper: Consistent avatar color selection
   */
  private getAvatarColor(email: string): 'blue' | 'green' | 'yellow' | 'purple' | 'red' | 'gray' {
    const colors: Array<'blue' | 'green' | 'yellow' | 'purple' | 'red' | 'gray'> = [
      'blue',
      'green',
      'yellow',
      'purple',
      'red',
      'gray',
    ];
    const code = email.charCodeAt(0) + email.charCodeAt(email.length - 1);
    return colors[code % colors.length];
  }
}

/**
 * Factory function to create TeamService instance
 */
export function createTeamService(db: BaseDatabase): TeamService {
  return new TeamService(db);
}
