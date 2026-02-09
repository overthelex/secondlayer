import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking_steps?: any[];
  decisions?: any[];
  citations?: any[];
  tool_calls?: any[];
  cost_tracking_id?: string;
  created_at: Date;
}

export class ConversationService {
  constructor(private db: Database) {}

  async createConversation(userId: string, title?: string): Promise<Conversation> {
    const id = uuidv4();
    const result = await this.db.query(
      `INSERT INTO conversations (id, user_id, title)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, userId, title || 'New conversation']
    );
    return result.rows[0];
  }

  async listConversations(
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<{ conversations: Conversation[]; total: number }> {
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const [result, countResult] = await Promise.all([
      this.db.query(
        `SELECT * FROM conversations
         WHERE user_id = $1
         ORDER BY updated_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      this.db.query(
        `SELECT COUNT(*) FROM conversations WHERE user_id = $1`,
        [userId]
      ),
    ]);

    return {
      conversations: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  async getConversation(conversationId: string, userId: string): Promise<Conversation | null> {
    const result = await this.db.query(
      `SELECT * FROM conversations WHERE id = $1 AND user_id = $2`,
      [conversationId, userId]
    );
    return result.rows[0] || null;
  }

  async addMessage(
    conversationId: string,
    userId: string,
    message: {
      role: 'user' | 'assistant';
      content: string;
      thinking_steps?: any[];
      decisions?: any[];
      citations?: any[];
      tool_calls?: any[];
      cost_tracking_id?: string;
    }
  ): Promise<ConversationMessage | null> {
    // Verify ownership
    const conv = await this.getConversation(conversationId, userId);
    if (!conv) return null;

    const id = uuidv4();
    const result = await this.db.query(
      `INSERT INTO conversation_messages
         (id, conversation_id, role, content, thinking_steps, decisions, citations, tool_calls, cost_tracking_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        conversationId,
        message.role,
        message.content,
        message.thinking_steps ? JSON.stringify(message.thinking_steps) : null,
        message.decisions ? JSON.stringify(message.decisions) : null,
        message.citations ? JSON.stringify(message.citations) : null,
        message.tool_calls ? JSON.stringify(message.tool_calls) : null,
        message.cost_tracking_id || null,
      ]
    );

    // Update conversation timestamp
    await this.db.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
      [conversationId]
    );

    return result.rows[0];
  }

  async getMessages(
    conversationId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<ConversationMessage[]> {
    // Verify ownership
    const conv = await this.getConversation(conversationId, userId);
    if (!conv) return [];

    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const result = await this.db.query(
      `SELECT * FROM conversation_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset]
    );
    return result.rows;
  }

  async updateTitle(conversationId: string, userId: string, title: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE conversations SET title = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING id`,
      [title, conversationId, userId]
    );
    return result.rows.length > 0;
  }

  async deleteConversation(conversationId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id`,
      [conversationId, userId]
    );
    return result.rows.length > 0;
  }

  async deleteAllConversations(userId: string): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM conversations WHERE user_id = $1`,
      [userId]
    );
    return result.rowCount || 0;
  }
}
