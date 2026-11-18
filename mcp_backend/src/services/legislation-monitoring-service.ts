import { diffWords } from 'diff';
import { createHash } from 'crypto';
import type { IDatabase } from '../domain/ports/index.js';
import type { RadaLegislationAdapter, LegislationArticle } from '../adapters/rada-legislation-adapter.js';
import type { EmailService } from './email-service.js';
import { logger } from '../utils/logger.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function generateDiffHtml(oldText: string, newText: string): string {
  const changes = diffWords(oldText, newText);
  return changes.map(part => {
    if (part.added) return `<ins class="diff-add">${escapeHtml(part.value)}</ins>`;
    if (part.removed) return `<del class="diff-del">${escapeHtml(part.value)}</del>`;
    return escapeHtml(part.value);
  }).join('');
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface Subscription {
  id: number;
  user_id: string;
  legislation_id: number;
  rada_id: string;
  title: string;
  short_title: string | null;
  type: string | null;
  notify_email: boolean;
  notify_inapp: boolean;
  created_at: string;
}

export interface LegislationChange {
  id: number;
  legislation_id: number;
  rada_id: string;
  article_number: string | null;
  change_type: 'added' | 'modified' | 'removed';
  old_text: string | null;
  new_text: string | null;
  diff_html: string | null;
  detected_at: string;
  version_date: string | null;
  title?: string;
}

export class LegislationMonitoringService {
  constructor(
    private db: IDatabase,
    private adapter: RadaLegislationAdapter,
    private emailService: EmailService
  ) {}

  async subscribe(userId: string, radaId: string, preferences?: { notify_email?: boolean; notify_inapp?: boolean }): Promise<Subscription> {
    // Get legislation_id from rada_id
    const legResult = await this.db.query(
      'SELECT id FROM legislation WHERE LOWER(rada_id) = LOWER($1)',
      [radaId]
    );

    if (legResult.rows.length === 0) {
      throw new Error(`Законодавство з rada_id "${radaId}" не знайдено в базі`);
    }

    const legislationId = legResult.rows[0].id;
    const notifyEmail = preferences?.notify_email ?? true;
    const notifyInapp = preferences?.notify_inapp ?? true;

    const result = await this.db.query(
      `INSERT INTO legislation_subscriptions (user_id, legislation_id, notify_email, notify_inapp)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, legislation_id) DO UPDATE SET
         notify_email = EXCLUDED.notify_email,
         notify_inapp = EXCLUDED.notify_inapp
       RETURNING *`,
      [userId, legislationId, notifyEmail, notifyInapp]
    );

    // Return with legislation info
    const sub = result.rows[0];
    const legInfo = await this.db.query(
      'SELECT rada_id, title, short_title, type FROM legislation WHERE id = $1',
      [legislationId]
    );
    return {
      ...sub,
      rada_id: legInfo.rows[0].rada_id,
      title: legInfo.rows[0].title,
      short_title: legInfo.rows[0].short_title,
      type: legInfo.rows[0].type,
    };
  }

  async unsubscribe(userId: string, radaId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM legislation_subscriptions
       WHERE user_id = $1 AND legislation_id = (SELECT id FROM legislation WHERE LOWER(rada_id) = LOWER($2))`,
      [userId, radaId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listSubscriptions(userId: string): Promise<Subscription[]> {
    const result = await this.db.query(
      `SELECT ls.*, l.rada_id, l.title, l.short_title, l.type
       FROM legislation_subscriptions ls
       JOIN legislation l ON l.id = ls.legislation_id
       WHERE ls.user_id = $1
       ORDER BY ls.created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  async isSubscribed(userId: string, radaId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM legislation_subscriptions ls
       JOIN legislation l ON l.id = ls.legislation_id
       WHERE ls.user_id = $1 AND LOWER(l.rada_id) = LOWER($2)`,
      [userId, radaId]
    );
    return result.rows.length > 0;
  }

  async checkForChanges(radaId: string): Promise<LegislationChange[]> {
    // Get legislation record
    const legResult = await this.db.query(
      'SELECT id FROM legislation WHERE LOWER(rada_id) = LOWER($1)',
      [radaId]
    );
    if (legResult.rows.length === 0) return [];
    const legislationId = legResult.rows[0].id;

    // Get current articles from DB
    const currentResult = await this.db.query(
      `SELECT article_number, full_text FROM legislation_articles
       WHERE legislation_id = $1 AND is_current = true
       ORDER BY article_number`,
      [legislationId]
    );
    const currentArticles = new Map<string, string>();
    for (const row of currentResult.rows) {
      currentArticles.set(row.article_number, row.full_text);
    }

    // Fetch fresh data from RADA
    let freshData: Awaited<ReturnType<RadaLegislationAdapter['fetchLegislation']>>;
    try {
      freshData = await this.adapter.fetchLegislation(radaId);
    } catch (err: any) {
      logger.error(`[LegMonitoring] Failed to fetch ${radaId} from RADA`, { error: err.message });
      return [];
    }

    const freshArticles = new Map<string, string>();
    for (const article of freshData.articles) {
      freshArticles.set(article.article_number, article.full_text);
    }

    const changes: LegislationChange[] = [];
    const now = new Date().toISOString();

    // Detect modified and removed articles
    for (const [articleNum, oldText] of currentArticles) {
      const newText = freshArticles.get(articleNum);
      if (newText === undefined) {
        // Article removed
        changes.push({
          id: 0, legislation_id: legislationId, rada_id: radaId,
          article_number: articleNum, change_type: 'removed',
          old_text: oldText, new_text: null, diff_html: null,
          detected_at: now, version_date: now,
        });
      } else if (hashText(oldText) !== hashText(newText)) {
        // Article modified
        const diffHtml = generateDiffHtml(oldText, newText);
        changes.push({
          id: 0, legislation_id: legislationId, rada_id: radaId,
          article_number: articleNum, change_type: 'modified',
          old_text: oldText, new_text: newText, diff_html: diffHtml,
          detected_at: now, version_date: now,
        });
      }
    }

    // Detect added articles
    for (const [articleNum, newText] of freshArticles) {
      if (!currentArticles.has(articleNum)) {
        changes.push({
          id: 0, legislation_id: legislationId, rada_id: radaId,
          article_number: articleNum, change_type: 'added',
          old_text: null, new_text: newText, diff_html: null,
          detected_at: now, version_date: now,
        });
      }
    }

    if (changes.length === 0) {
      logger.info(`[LegMonitoring] No changes detected for ${radaId}`);
      return [];
    }

    logger.info(`[LegMonitoring] Detected ${changes.length} changes for ${radaId}`);

    // Store changes in DB
    for (const change of changes) {
      const result = await this.db.query(
        `INSERT INTO legislation_changes (legislation_id, rada_id, article_number, change_type, old_text, new_text, diff_html, detected_at, version_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [change.legislation_id, change.rada_id, change.article_number, change.change_type,
         change.old_text, change.new_text, change.diff_html, change.detected_at, change.version_date]
      );
      change.id = result.rows[0].id;
    }

    // Update DB articles: mark old as not current, save fresh via adapter
    await this.db.query(
      `UPDATE legislation_articles SET is_current = false WHERE legislation_id = $1 AND is_current = true`,
      [legislationId]
    );
    await this.adapter.saveLegislationToDatabase(freshData.metadata, freshData.articles);

    return changes;
  }

  async checkAllSubscribedLegislation(): Promise<void> {
    // Get distinct rada_ids that have at least one subscriber
    const result = await this.db.query(
      `SELECT DISTINCT l.rada_id
       FROM legislation_subscriptions ls
       JOIN legislation l ON l.id = ls.legislation_id`
    );

    logger.info(`[LegMonitoring] Checking ${result.rows.length} subscribed legislation documents`);

    for (const row of result.rows) {
      try {
        const changes = await this.checkForChanges(row.rada_id);
        if (changes.length > 0) {
          await this.notifySubscribers(row.rada_id, changes);
        }
        // Small delay to not hammer RADA API
        await new Promise(r => setTimeout(r, 2000));
      } catch (err: any) {
        logger.error(`[LegMonitoring] Error checking ${row.rada_id}`, { error: err.message });
      }
    }
  }

  private async notifySubscribers(radaId: string, changes: LegislationChange[]): Promise<void> {
    // Get legislation info
    const legResult = await this.db.query(
      'SELECT id, title, short_title FROM legislation WHERE LOWER(rada_id) = LOWER($1)',
      [radaId]
    );
    if (legResult.rows.length === 0) return;
    const leg = legResult.rows[0];

    // Get subscribers
    const subResult = await this.db.query(
      `SELECT ls.user_id, ls.notify_email, ls.notify_inapp, u.email, u.name
       FROM legislation_subscriptions ls
       JOIN users u ON u.id = ls.user_id
       WHERE ls.legislation_id = $1`,
      [leg.id]
    );

    const changedArticles = changes.map(c => c.article_number).filter(Boolean).join(', ');
    const summary = `Виявлено ${changes.length} змін у ${leg.short_title || leg.title}`;
    const link = `/legislation/monitoring?rada_id=${radaId}`;

    for (const sub of subResult.rows) {
      // In-app notification
      if (sub.notify_inapp) {
        await this.db.query(
          `INSERT INTO user_notifications (user_id, type, title, body, link, metadata)
           VALUES ($1, 'legislation_change', $2, $3, $4, $5)`,
          [
            sub.user_id,
            summary,
            `Змінені статті: ${changedArticles || 'структурні зміни'}`,
            link,
            JSON.stringify({ rada_id: radaId, change_count: changes.length }),
          ]
        );
      }

      // Email notification
      if (sub.notify_email && sub.email) {
        try {
          await this.emailService.sendLegislationChangeNotification({
            email: sub.email,
            name: sub.name || 'Користувач',
            lawTitle: leg.short_title || leg.title,
            radaId,
            changeCount: changes.length,
            changedArticles,
            link,
          });
        } catch (err: any) {
          logger.error(`[LegMonitoring] Failed to send email to ${sub.user_id}`, { error: err.message });
        }
      }
    }
  }

  async getChangeFeed(userId: string, options?: { radaId?: string; limit?: number; offset?: number }): Promise<{ changes: LegislationChange[]; total: number }> {
    const limit = Math.min(options?.limit || 50, 100);
    const offset = options?.offset || 0;

    let whereClause = `WHERE lc.legislation_id IN (SELECT legislation_id FROM legislation_subscriptions WHERE user_id = $1)`;
    const params: any[] = [userId];

    if (options?.radaId) {
      params.push(options.radaId);
      whereClause += ` AND lc.rada_id = $${params.length}`;
    }

    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM legislation_changes lc ${whereClause}`,
      params
    );

    params.push(limit, offset);
    const result = await this.db.query(
      `SELECT lc.*, l.title, l.short_title
       FROM legislation_changes lc
       JOIN legislation l ON l.id = lc.legislation_id
       ${whereClause}
       ORDER BY lc.detected_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      changes: result.rows,
      total: parseInt(countResult.rows[0].count),
    };
  }

  async getChange(changeId: number): Promise<LegislationChange | null> {
    const result = await this.db.query(
      `SELECT lc.*, l.title, l.short_title
       FROM legislation_changes lc
       JOIN legislation l ON l.id = lc.legislation_id
       WHERE lc.id = $1`,
      [changeId]
    );
    return result.rows[0] || null;
  }

  async getChangesForLegislation(radaId: string, limit = 50): Promise<LegislationChange[]> {
    const result = await this.db.query(
      `SELECT lc.*, l.title, l.short_title
       FROM legislation_changes lc
       JOIN legislation l ON l.id = lc.legislation_id
       WHERE lc.rada_id = $1
       ORDER BY lc.detected_at DESC
       LIMIT $2`,
      [radaId, limit]
    );
    return result.rows;
  }

  // Notifications
  async getNotifications(userId: string, options?: { unreadOnly?: boolean; limit?: number; offset?: number }): Promise<{ notifications: any[]; unreadCount: number }> {
    const limit = Math.min(options?.limit || 50, 100);
    const offset = options?.offset || 0;

    let whereClause = 'WHERE user_id = $1';
    if (options?.unreadOnly) {
      whereClause += ' AND is_read = false';
    }

    const countResult = await this.db.query(
      `SELECT COUNT(*) FILTER (WHERE is_read = false) as unread_count FROM user_notifications WHERE user_id = $1`,
      [userId]
    );

    const result = await this.db.query(
      `SELECT * FROM user_notifications ${whereClause} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return {
      notifications: result.rows,
      unreadCount: parseInt(countResult.rows[0].unread_count),
    };
  }

  async markNotificationRead(userId: string, notificationId: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE user_notifications SET is_read = true WHERE id = $1 AND user_id = $2`,
      [notificationId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markAllNotificationsRead(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE user_notifications SET is_read = true WHERE user_id = $1 AND is_read = false`,
      [userId]
    );
  }
}
