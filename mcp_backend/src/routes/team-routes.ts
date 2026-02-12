/**
 * Team Routes
 * Endpoints for team management, members, invitations, and statistics
 */

import express, { Router, Request, Response } from 'express';
import { TeamService } from '../services/team-service.js';
import { logger } from '@secondlayer/shared';

export interface AuthenticatedRequest extends Request {
  user?: any;
}

export function createTeamRoutes(teamService: TeamService): Router {
  const router = express.Router();

  /**
   * GET /api/team/organization
   * Get user's organization status (for setup modal)
   */
  router.get('/organization', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      const organization = await teamService.getUserOrganization(userId);
      res.json({
        success: true,
        data: organization,
      });
    } catch (error) {
      logger.error('Error fetching organization', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch organization',
      });
    }
  });

  /**
   * POST /api/team/organization
   * Create organization for user
   */
  router.post('/organization', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      const userEmail = req.user?.email;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      const { name, taxId, contactEmail, description } = req.body;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Organization name is required',
        });
      }

      // Check if user already has an organization
      const existing = await teamService.getUserOrganization(userId);
      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'User already has an organization',
          data: existing,
        });
      }

      const organization = await teamService.createUserOrganization(userId, userEmail || '', {
        name: name.trim(),
        taxId,
        contactEmail,
        description,
      });

      res.status(201).json({
        success: true,
        data: organization,
      });
    } catch (error) {
      logger.error('Error creating organization', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create organization',
      });
    }
  });

  /**
   * GET /api/team/members
   * Get all team members with statistics
   */
  router.get('/members', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      const members = await teamService.getTeamMembers(userId);
      res.json({
        success: true,
        data: members,
        count: members.length,
      });
    } catch (error) {
      logger.error('Error fetching team members', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch team members',
      });
    }
  });

  /**
   * POST /api/team/invite
   * Invite a new team member
   */
  router.post('/invite', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      const { email, role } = req.body;

      if (!email || !role) {
        return res.status(400).json({
          success: false,
          error: 'Email and role are required',
        });
      }

      if (!['admin', 'user', 'observer'].includes(role)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid role. Must be admin, user, or observer',
        });
      }

      const invitation = await teamService.inviteMember(userId, email, role);

      res.status(201).json({
        success: true,
        data: invitation,
      });
    } catch (error) {
      logger.error('Error inviting team member', { error });
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to invite team member',
      });
    }
  });

  /**
   * PUT /api/team/members/:memberId
   * Update member role
   */
  router.put('/members/:memberId', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      const memberId = typeof req.params.memberId === 'string' ? req.params.memberId : req.params.memberId[0];
      const { role } = req.body;

      if (!role) {
        return res.status(400).json({
          success: false,
          error: 'Role is required',
        });
      }

      if (!['owner', 'admin', 'user', 'observer'].includes(role)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid role',
        });
      }

      await teamService.updateMemberRole(userId, memberId, role);

      res.json({
        success: true,
        message: 'Member role updated successfully',
      });
    } catch (error) {
      logger.error('Error updating team member', { error });
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update team member',
      });
    }
  });

  /**
   * DELETE /api/team/members/:memberId
   * Remove member from organization
   */
  router.delete('/members/:memberId', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      const memberId = typeof req.params.memberId === 'string' ? req.params.memberId : req.params.memberId[0];

      await teamService.removeMember(userId, memberId);

      res.json({
        success: true,
        message: 'Member removed successfully',
      });
    } catch (error) {
      logger.error('Error removing team member', { error });
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove team member',
      });
    }
  });

  /**
   * POST /api/team/members/:memberId/resend-invite
   * Resend invitation email
   */
  router.post('/members/:memberId/resend-invite', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      const memberId = typeof req.params.memberId === 'string' ? req.params.memberId : req.params.memberId[0];

      await teamService.resendInvitation(userId, memberId);

      res.json({
        success: true,
        message: 'Invitation resent successfully',
      });
    } catch (error) {
      logger.error('Error resending invitation', { error });
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to resend invitation',
      });
    }
  });

  /**
   * GET /api/team/stats
   * Get team statistics
   */
  router.get('/stats', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      const stats = await teamService.getTeamStats(userId);

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error('Error fetching team stats', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch team stats',
      });
    }
  });

  return router;
}
