import { Database } from '../database/database.js';
import { AuditService } from './audit-service.js';
import { logger } from '../utils/logger.js';

export interface TimeEntry {
    id: string;
    matter_id: string;
    user_id: string;
    entry_date: string;
    duration_minutes: number;
    hourly_rate_usd: number;
    billable: boolean;
    status: 'draft' | 'submitted' | 'approved' | 'invoiced' | 'rejected';
    description: string;
    notes?: string;
    invoice_id?: string;
    created_by: string;
    approved_by?: string;
    submitted_at?: string;
    approved_at?: string;
    created_at: string;
    updated_at: string;
    // Joined fields
    matter_name?: string;
    user_name?: string;
    user_email?: string;
}

export interface ActiveTimer {
    id: string;
    user_id: string;
    matter_id: string;
    description?: string;
    started_at: string;
    last_ping_at: string;
    elapsed_seconds: number;
    // Joined fields
    matter_name?: string;
}

export interface UserBillingRate {
    id: string;
    user_id: string;
    hourly_rate_usd: number;
    effective_from: string;
    effective_to?: string;
    is_default: boolean;
    created_by: string;
    created_at: string;
    updated_at: string;
}

export interface CreateTimeEntryParams {
    matter_id: string;
    user_id: string;
    entry_date?: string;
    duration_minutes: number;
    description: string;
    billable?: boolean;
    notes?: string;
    created_by: string;
}

export interface UpdateTimeEntryParams {
    entry_date?: string;
    duration_minutes?: number;
    description?: string;
    billable?: boolean;
    notes?: string;
}

export interface ListTimeEntriesParams {
    matter_id?: string;
    user_id?: string;
    status?: string;
    billable?: boolean;
    date_from?: string;
    date_to?: string;
    limit?: number;
    offset?: number;
}

export interface StartTimerParams {
    user_id: string;
    matter_id: string;
    description?: string;
}

export class TimeEntryService {
    constructor(
        private db: Database,
        private auditService: AuditService
    ) {}

    /**
     * Create a new time entry
     */
    async createEntry(params: CreateTimeEntryParams): Promise<TimeEntry> {
        // Get user's current billing rate
        const hourlyRate = await this.getUserRate(
            params.user_id,
            params.entry_date || new Date().toISOString().split('T')[0]
        );

        const result = await this.db.query(
            `INSERT INTO time_entries (
                matter_id, user_id, entry_date, duration_minutes,
                hourly_rate_usd, billable, description, notes, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [
                params.matter_id,
                params.user_id,
                params.entry_date || new Date().toISOString().split('T')[0],
                params.duration_minutes,
                hourlyRate,
                params.billable !== false, // Default true
                params.description,
                params.notes || null,
                params.created_by
            ]
        );

        const entry = result.rows[0];

        // Audit log
        await this.auditService.log({
            userId: params.created_by,
            action: 'time_entry.create',
            resourceType: 'time_entry',
            resourceId: entry.id,
            details: { matter_id: params.matter_id, duration_minutes: params.duration_minutes, billable: entry.billable }
        });

        logger.info('[TimeEntry] Time entry created', {
            timeEntryId: entry.id,
            matterId: params.matter_id,
            durationMinutes: params.duration_minutes
        });

        return entry;
    }

    /**
     * Update time entry (only allowed if status is 'draft' or 'rejected')
     */
    async updateEntry(
        entryId: string,
        params: UpdateTimeEntryParams,
        userId: string
    ): Promise<TimeEntry> {
        // Check current status
        const checkResult = await this.db.query(
            'SELECT status, matter_id FROM time_entries WHERE id = $1',
            [entryId]
        );

        if (checkResult.rows.length === 0) {
            throw new Error('Time entry not found');
        }

        const { status: currentStatus } = checkResult.rows[0];
        if (!['draft', 'rejected'].includes(currentStatus)) {
            throw new Error(`Cannot update time entry with status: ${currentStatus}`);
        }

        const updates: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (params.entry_date !== undefined) {
            updates.push(`entry_date = $${paramIndex++}`);
            values.push(params.entry_date);
        }
        if (params.duration_minutes !== undefined) {
            updates.push(`duration_minutes = $${paramIndex++}`);
            values.push(params.duration_minutes);
        }
        if (params.description !== undefined) {
            updates.push(`description = $${paramIndex++}`);
            values.push(params.description);
        }
        if (params.billable !== undefined) {
            updates.push(`billable = $${paramIndex++}`);
            values.push(params.billable);
        }
        if (params.notes !== undefined) {
            updates.push(`notes = $${paramIndex++}`);
            values.push(params.notes);
        }

        if (updates.length === 0) {
            throw new Error('No fields to update');
        }

        values.push(entryId);

        const result = await this.db.query(
            `UPDATE time_entries
            SET ${updates.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING *`,
            values
        );

        const entry = result.rows[0];

        // Audit log
        await this.auditService.log({
            userId,
            action: 'time_entry.update',
            resourceType: 'time_entry',
            resourceId: entryId,
            details: params
        });

        logger.info('[TimeEntry] Time entry updated', { timeEntryId: entryId, changes: params });

        return entry;
    }

    /**
     * Delete time entry (only allowed if status is 'draft' or 'rejected')
     */
    async deleteEntry(entryId: string, userId: string): Promise<void> {
        // Get entry for audit
        const checkResult = await this.db.query(
            'SELECT status, matter_id FROM time_entries WHERE id = $1',
            [entryId]
        );

        if (checkResult.rows.length === 0) {
            throw new Error('Time entry not found');
        }

        const { status, matter_id } = checkResult.rows[0];
        if (!['draft', 'rejected'].includes(status)) {
            throw new Error(`Cannot delete time entry with status: ${status}`);
        }

        await this.db.query('DELETE FROM time_entries WHERE id = $1', [entryId]);

        // Audit log
        await this.auditService.log({
            userId,
            action: 'time_entry.delete',
            resourceType: 'time_entry',
            resourceId: entryId,
            details: { matter_id }
        });

        logger.info('[TimeEntry] Time entry deleted', { timeEntryId: entryId });
    }

    /**
     * List time entries with filters
     */
    async listEntries(params: ListTimeEntriesParams = {}): Promise<{ entries: TimeEntry[]; total: number }> {
        const conditions: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (params.matter_id) {
            conditions.push(`te.matter_id = $${paramIndex++}`);
            values.push(params.matter_id);
        }
        if (params.user_id) {
            conditions.push(`te.user_id = $${paramIndex++}`);
            values.push(params.user_id);
        }
        if (params.status) {
            conditions.push(`te.status = $${paramIndex++}`);
            values.push(params.status);
        }
        if (params.billable !== undefined) {
            conditions.push(`te.billable = $${paramIndex++}`);
            values.push(params.billable);
        }
        if (params.date_from) {
            conditions.push(`te.entry_date >= $${paramIndex++}`);
            values.push(params.date_from);
        }
        if (params.date_to) {
            conditions.push(`te.entry_date <= $${paramIndex++}`);
            values.push(params.date_to);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Get total count
        const countResult = await this.db.query(
            `SELECT COUNT(*) as count FROM time_entries te ${whereClause}`,
            values
        );
        const total = parseInt(countResult.rows[0].count, 10);

        // Get entries with joins
        const limit = params.limit || 100;
        const offset = params.offset || 0;

        const result = await this.db.query(
            `SELECT
                te.*,
                m.matter_name as matter_name,
                u.name as user_name,
                u.email as user_email
            FROM time_entries te
            LEFT JOIN matters m ON te.matter_id = m.id
            LEFT JOIN users u ON te.user_id = u.id
            ${whereClause}
            ORDER BY te.entry_date DESC, te.created_at DESC
            LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
            [...values, limit, offset]
        );

        return {
            entries: result.rows,
            total
        };
    }

    /**
     * Submit time entry for approval
     */
    async submitForApproval(entryId: string, userId: string): Promise<TimeEntry> {
        const result = await this.db.query(
            `UPDATE time_entries
            SET status = 'submitted', submitted_at = NOW()
            WHERE id = $1 AND status = 'draft'
            RETURNING *`,
            [entryId]
        );

        if (result.rows.length === 0) {
            throw new Error('Time entry not found or already submitted');
        }

        const entry = result.rows[0];

        await this.auditService.log({
            userId,
            action: 'time_entry.submit',
            resourceType: 'time_entry',
            resourceId: entryId,
            details: { matter_id: entry.matter_id }
        });

        logger.info('[TimeEntry] Time entry submitted for approval', { timeEntryId: entryId });

        return entry;
    }

    /**
     * Approve time entry
     */
    async approveEntry(entryId: string, approverId: string): Promise<TimeEntry> {
        const result = await this.db.query(
            `UPDATE time_entries
            SET status = 'approved', approved_by = $2, approved_at = NOW()
            WHERE id = $1 AND status = 'submitted'
            RETURNING *`,
            [entryId, approverId]
        );

        if (result.rows.length === 0) {
            throw new Error('Time entry not found or not in submitted status');
        }

        const entry = result.rows[0];

        await this.auditService.log({
            userId: approverId,
            action: 'time_entry.approve',
            resourceType: 'time_entry',
            resourceId: entryId,
            details: { matter_id: entry.matter_id }
        });

        logger.info('[TimeEntry] Time entry approved', { timeEntryId: entryId, approverId });

        return entry;
    }

    /**
     * Reject time entry
     */
    async rejectEntry(entryId: string, approverId: string, notes?: string): Promise<TimeEntry> {
        const result = await this.db.query(
            `UPDATE time_entries
            SET status = 'rejected', approved_by = $2, notes = COALESCE($3, notes)
            WHERE id = $1 AND status = 'submitted'
            RETURNING *`,
            [entryId, approverId, notes]
        );

        if (result.rows.length === 0) {
            throw new Error('Time entry not found or not in submitted status');
        }

        const entry = result.rows[0];

        await this.auditService.log({
            userId: approverId,
            action: 'time_entry.reject',
            resourceType: 'time_entry',
            resourceId: entryId,
            details: { matter_id: entry.matter_id, notes }
        });

        logger.info('[TimeEntry] Time entry rejected', { timeEntryId: entryId, approverId });

        return entry;
    }

    // ============================================================================
    // Timer Methods
    // ============================================================================

    /**
     * Start a timer for a matter
     */
    async startTimer(params: StartTimerParams): Promise<ActiveTimer> {
        // Check if timer already exists
        const existingResult = await this.db.query(
            `SELECT *, EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER as elapsed_seconds
            FROM active_timers
            WHERE user_id = $1 AND matter_id = $2`,
            [params.user_id, params.matter_id]
        );

        if (existingResult.rows.length > 0) {
            return existingResult.rows[0]; // Return existing timer
        }

        // Create new timer
        const result = await this.db.query(
            `INSERT INTO active_timers (user_id, matter_id, description)
            VALUES ($1, $2, $3)
            RETURNING *, 0 as elapsed_seconds`,
            [params.user_id, params.matter_id, params.description || null]
        );

        const timer = result.rows[0];

        await this.auditService.log({
            userId: params.user_id,
            action: 'timer.start',
            resourceType: 'timer',
            resourceId: timer.id,
            details: { matter_id: params.matter_id }
        });

        logger.info('[TimeEntry] Timer started', {
            timerId: timer.id,
            userId: params.user_id,
            matterId: params.matter_id
        });

        return timer;
    }

    /**
     * Stop a timer and create time entry
     */
    async stopTimer(
        userId: string,
        matterId: string,
        createEntry: boolean = true
    ): Promise<{ timer: ActiveTimer; timeEntry?: TimeEntry }> {
        // Get timer
        const timerResult = await this.db.query(
            `SELECT *, EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER as elapsed_seconds
            FROM active_timers
            WHERE user_id = $1 AND matter_id = $2`,
            [userId, matterId]
        );

        if (timerResult.rows.length === 0) {
            throw new Error('No active timer found');
        }

        const timer = timerResult.rows[0];
        const durationMinutes = Math.ceil(timer.elapsed_seconds / 60);

        let timeEntry: TimeEntry | undefined;

        // Create time entry if requested
        if (createEntry && durationMinutes > 0) {
            const hourlyRate = await this.getUserRate(userId);

            const entryResult = await this.db.query(
                `INSERT INTO time_entries (
                    matter_id, user_id, duration_minutes, hourly_rate_usd,
                    billable, description, created_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *`,
                [
                    matterId,
                    userId,
                    durationMinutes,
                    hourlyRate,
                    true,
                    timer.description || 'Time tracked via timer',
                    userId
                ]
            );

            timeEntry = entryResult.rows[0];

            await this.auditService.log({
                userId,
                action: 'time_entry.create_from_timer',
                resourceType: 'time_entry',
                resourceId: timeEntry!.id,
                details: { matter_id: matterId, timer_id: timer.id, duration_minutes: durationMinutes }
            });
        }

        // Delete timer
        await this.db.query(
            'DELETE FROM active_timers WHERE id = $1',
            [timer.id]
        );

        await this.auditService.log({
            userId,
            action: 'timer.stop',
            resourceType: 'timer',
            resourceId: timer.id,
            details: { matter_id: matterId, elapsed_seconds: timer.elapsed_seconds }
        });

        logger.info('[TimeEntry] Timer stopped', {
            timerId: timer.id,
            durationMinutes,
            timeEntryCreated: !!timeEntry
        });

        return { timer, timeEntry };
    }

    /**
     * Get active timers for a user
     */
    async getActiveTimers(userId: string): Promise<ActiveTimer[]> {
        const result = await this.db.query(
            `SELECT
                at.*,
                EXTRACT(EPOCH FROM (NOW() - at.started_at))::INTEGER as elapsed_seconds,
                m.matter_name as matter_name
            FROM active_timers at
            LEFT JOIN matters m ON at.matter_id = m.id
            WHERE at.user_id = $1
            ORDER BY at.started_at DESC`,
            [userId]
        );

        return result.rows as any;
    }

    /**
     * Ping timer to keep it alive
     */
    async pingTimer(userId: string, matterId: string): Promise<void> {
        await this.db.query(
            `UPDATE active_timers
            SET last_ping_at = NOW()
            WHERE user_id = $1 AND matter_id = $2`,
            [userId, matterId]
        );
    }

    /**
     * Clean up stale timers (called by cron job)
     */
    async cleanupStaleTimers(): Promise<number> {
        const result = await this.db.query(
            'SELECT cleanup_stale_timers() as cleanup_stale_timers'
        );
        const count = result.rows[0].cleanup_stale_timers;

        logger.info('[TimeEntry] Stale timers cleaned up', { count });

        return count;
    }

    // ============================================================================
    // Billing Rate Methods
    // ============================================================================

    /**
     * Get user's current billing rate
     */
    async getUserRate(userId: string, date?: string): Promise<number> {
        const result = await this.db.query(
            'SELECT get_user_billing_rate($1, $2) as get_user_billing_rate',
            [userId, date || new Date().toISOString().split('T')[0]]
        );

        return result.rows[0].get_user_billing_rate || 0 as any;
    }

    /**
     * Set user's billing rate
     */
    async setUserRate(
        userId: string,
        hourlyRateUsd: number,
        effectiveFrom: string,
        effectiveTo: string | null,
        isDefault: boolean,
        createdBy: string
    ): Promise<UserBillingRate> {
        const result = await this.db.query(
            `INSERT INTO user_billing_rates (
                user_id, hourly_rate_usd, effective_from, effective_to, is_default, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *`,
            [userId, hourlyRateUsd, effectiveFrom, effectiveTo, isDefault, createdBy]
        );

        const rate = result.rows[0];

        await this.auditService.log({
            userId: createdBy,
            action: 'billing_rate.set',
            resourceType: 'billing_rate',
            resourceId: rate.id,
            details: { user_id: userId, hourly_rate_usd: hourlyRateUsd }
        });

        logger.info('[TimeEntry] Billing rate set', { userId, hourlyRateUsd, effectiveFrom });

        return rate;
    }

    /**
     * Get user's billing rate history
     */
    async getUserRateHistory(userId: string): Promise<UserBillingRate[]> {
        const result = await this.db.query(
            `SELECT * FROM user_billing_rates
            WHERE user_id = $1
            ORDER BY effective_from DESC`,
            [userId]
        );

        return result.rows as any;
    }
}
