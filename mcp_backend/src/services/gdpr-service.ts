import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { MinioService } from './minio-service.js';
import { EmbeddingService } from './embedding-service.js';

export interface GdprRequest {
  id: string;
  user_id: string;
  request_type: 'export' | 'deletion' | 'access';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  requested_at: Date;
  completed_at?: Date;
  download_url?: string;
  download_expires_at?: Date;
  metadata?: any;
}

export class GdprService {
  constructor(
    private db: Database,
    private minioService: MinioService,
    private embeddingService: EmbeddingService
  ) {}

  async requestExport(userId: string): Promise<GdprRequest> {
    const id = uuidv4();

    // Create request record
    const result = await this.db.query(
      `INSERT INTO gdpr_requests (id, user_id, request_type, status)
       VALUES ($1, $2, 'export', 'processing')
       RETURNING *`,
      [id, userId]
    );

    // Gather data in background
    this.gatherExportData(id, userId).catch((err) => {
      logger.error('[GDPR] Export failed', { requestId: id, error: err.message });
    });

    return result.rows[0];
  }

  private async gatherExportData(requestId: string, userId: string): Promise<void> {
    try {
      // Gather all user data
      const [profile, conversations, documents, uploads, costTracking, billing, apiKeys] =
        await Promise.all([
          this.db.query(`SELECT id, email, name, picture, role, created_at FROM users WHERE id = $1`, [userId]),
          this.db.query(
            `SELECT c.*, json_agg(
               json_build_object('id', m.id, 'role', m.role, 'content', m.content, 'created_at', m.created_at)
               ORDER BY m.created_at
             ) FILTER (WHERE m.id IS NOT NULL) as messages
             FROM conversations c
             LEFT JOIN conversation_messages m ON m.conversation_id = c.id
             WHERE c.user_id = $1
             GROUP BY c.id
             ORDER BY c.updated_at DESC`,
            [userId]
          ),
          this.db.query(
            `SELECT id, type, title, metadata, created_at FROM documents WHERE user_id = $1`,
            [userId]
          ),
          this.db.query(
            `SELECT id, file_name, file_size, mime_type, status, created_at
             FROM upload_sessions WHERE user_id = $1`,
            [userId]
          ),
          this.db.query(
            `SELECT id, tool_name, user_query, status, total_cost_usd, created_at
             FROM cost_tracking WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000`,
            [userId]
          ),
          this.db.query(
            `SELECT ub.*, json_agg(
               json_build_object('id', bt.id, 'type', bt.type, 'amount_usd', bt.amount_usd, 'created_at', bt.created_at)
               ORDER BY bt.created_at DESC
             ) FILTER (WHERE bt.id IS NOT NULL) as transactions
             FROM user_billing ub
             LEFT JOIN billing_transactions bt ON bt.user_id = ub.user_id
             WHERE ub.user_id = $1
             GROUP BY ub.user_id, ub.balance_usd, ub.balance_uah, ub.pricing_tier,
                      ub.is_active, ub.created_at, ub.updated_at`,
            [userId]
          ),
          this.db.query(
            `SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = $1`,
            [userId]
          ),
        ]);

      const exportData = {
        exported_at: new Date().toISOString(),
        profile: profile.rows[0] || null,
        conversations: conversations.rows,
        documents: documents.rows,
        uploads: uploads.rows,
        usage_history: costTracking.rows,
        billing: billing.rows[0] || null,
        api_keys: apiKeys.rows,
      };

      // Store as JSON string in metadata
      const exportJson = JSON.stringify(exportData, null, 2);

      await this.db.query(
        `UPDATE gdpr_requests
         SET status = 'completed',
             completed_at = NOW(),
             metadata = $1,
             download_expires_at = NOW() + INTERVAL '7 days'
         WHERE id = $2`,
        [JSON.stringify({ size_bytes: exportJson.length, data: exportData }), requestId]
      );

      logger.info('[GDPR] Export completed', { requestId, userId, sizeBytes: exportJson.length });
    } catch (error: any) {
      await this.db.query(
        `UPDATE gdpr_requests SET status = 'failed', metadata = $1 WHERE id = $2`,
        [JSON.stringify({ error: error.message }), requestId]
      );
      throw error;
    }
  }

  async getExportData(requestId: string, userId: string): Promise<GdprRequest | null> {
    const result = await this.db.query(
      `SELECT * FROM gdpr_requests WHERE id = $1 AND user_id = $2`,
      [requestId, userId]
    );
    return result.rows[0] || null;
  }

  async requestDeletion(userId: string): Promise<GdprRequest> {
    const id = uuidv4();

    const result = await this.db.query(
      `INSERT INTO gdpr_requests (id, user_id, request_type, status)
       VALUES ($1, $2, 'deletion', 'processing')
       RETURNING *`,
      [id, userId]
    );

    // Process deletion in background
    this.processDeletion(id, userId).catch((err) => {
      logger.error('[GDPR] Deletion failed', { requestId: id, error: err.message });
    });

    return result.rows[0];
  }

  private async processDeletion(requestId: string, userId: string): Promise<void> {
    try {
      // 1. Get user document IDs for cleanup
      const docsResult = await this.db.query(
        `SELECT id FROM documents WHERE user_id = $1`,
        [userId]
      );
      const docIds = docsResult.rows.map((r: any) => r.id);

      // 2. Check legal holds — separate held vs deletable docs
      const heldDocIds: string[] = [];
      const deletableDocIds: string[] = [];

      for (const docId of docIds) {
        try {
          const holdCheck = await this.db.query(
            `SELECT * FROM can_delete_document($1)`,
            [docId]
          );
          const row = holdCheck.rows[0];
          if (row && row.can_delete) {
            deletableDocIds.push(docId);
          } else {
            heldDocIds.push(docId);
          }
        } catch (err: any) {
          logger.warn('[GDPR] Hold check failed for doc, treating as held', { docId, error: err.message });
          heldDocIds.push(docId);
        }
      }

      // 3. Delete Qdrant vectors for ALL user documents (deletable + held)
      for (const docId of [...deletableDocIds, ...heldDocIds]) {
        try {
          await this.embeddingService.deleteByDocId(docId);
        } catch (err: any) {
          logger.warn('[GDPR] Failed to delete vectors for doc', { docId, error: err.message });
        }
      }

      // 4. Delete deletable documents from PostgreSQL
      //    (document_sections, embedding_chunks, citation_links, precedent_status cascade automatically)
      if (deletableDocIds.length > 0) {
        // Remove custody chain entries (table has immutable rule, must disable temporarily)
        await this.db.query(`ALTER TABLE document_custody_chain DISABLE RULE no_delete_custody_chain`);
        await this.db.query(
          `DELETE FROM document_custody_chain WHERE document_id = ANY($1)`,
          [deletableDocIds]
        );
        await this.db.query(`ALTER TABLE document_custody_chain ENABLE RULE no_delete_custody_chain`);

        // Now delete the documents themselves (sections, chunks, citations cascade)
        await this.db.query(
          `DELETE FROM documents WHERE id = ANY($1)`,
          [deletableDocIds]
        );
      }

      // 5. Anonymize held documents (user_id → NULL, keep data for legal compliance)
      if (heldDocIds.length > 0) {
        await this.db.query(
          `UPDATE documents SET user_id = NULL WHERE id = ANY($1)`,
          [heldDocIds]
        );
        logger.info('[GDPR] Held documents anonymized (not deleted)', {
          userId, heldCount: heldDocIds.length,
        });
      }

      // 6. Delete MinIO storage
      try {
        await this.minioService.deleteBucket(`user-${userId}`);
      } catch (err: any) {
        logger.warn('[GDPR] Failed to delete MinIO bucket', { userId, error: err.message });
      }

      // 7. Anonymize cost_tracking (keep for aggregate analytics)
      await this.db.query(
        `UPDATE cost_tracking SET user_id = NULL, user_query = NULL WHERE user_id = $1`,
        [userId]
      );

      // 8. Delete the user record (cascades: conversations, messages, uploads,
      //    api_keys, billing, credits, sessions, webauthn, GDPR requests,
      //    matter_team, active_timers, time_entries, eula, preferences, presets,
      //    email_verification_tokens, organizations)
      await this.db.query(`DELETE FROM users WHERE id = $1`, [userId]);

      // 9. Update GDPR request (row survives with user_id=NULL via ON DELETE SET NULL)
      await this.db.query(
        `UPDATE gdpr_requests SET status = 'completed', completed_at = NOW(), metadata = $1
         WHERE id = $2`,
        [
          JSON.stringify({
            original_user_id: userId,
            documentsDeleted: deletableDocIds.length,
            documentsHeld: heldDocIds.length,
            heldDocumentIds: heldDocIds,
          }),
          requestId,
        ]
      );

      logger.info('[GDPR] Deletion completed', {
        requestId,
        userId,
        documentsDeleted: deletableDocIds.length,
        documentsHeld: heldDocIds.length,
      });
    } catch (error: any) {
      await this.db.query(
        `UPDATE gdpr_requests SET status = 'failed', metadata = $1 WHERE id = $2`,
        [JSON.stringify({ error: error.message }), requestId]
      ).catch(() => {});
      throw error;
    }
  }

  async listRequests(userId: string): Promise<GdprRequest[]> {
    const result = await this.db.query(
      `SELECT id, user_id, request_type, status, requested_at, completed_at, download_expires_at
       FROM gdpr_requests
       WHERE user_id = $1
       ORDER BY requested_at DESC`,
      [userId]
    );
    return result.rows;
  }
}
