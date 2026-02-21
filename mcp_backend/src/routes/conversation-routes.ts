import { Router, Response } from 'express';
import { ConversationService } from '../services/conversation-service.js';
import { AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { logger } from '../utils/logger.js';

export function createConversationRouter(conversationService: ConversationService): Router {
  const router = Router();

  // POST / - Create conversation
  router.post('/', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { title } = req.body;
      const conversation = await conversationService.createConversation(userId, title);
      res.status(201).json(conversation);
    } catch (error: any) {
      logger.error('[Conversations] Create failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET / - List conversations (paginated)
  router.get('/', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await conversationService.listConversations(userId, { limit, offset });
      res.json(result);
    } catch (error: any) {
      logger.error('[Conversations] List failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /:id - Get conversation with messages
  router.get('/:id', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const convId = req.params.id as string;
      const conversation = await conversationService.getConversation(convId, userId);
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

      const messages = await conversationService.getMessages(convId, userId);
      res.json({ ...conversation, messages });
    } catch (error: any) {
      logger.error('[Conversations] Get failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // PUT /:id - Rename conversation
  router.put('/:id', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { title } = req.body;
      if (!title) return res.status(400).json({ error: 'Title required' });

      const updated = await conversationService.updateTitle(req.params.id as string, userId, title);
      if (!updated) return res.status(404).json({ error: 'Conversation not found' });

      res.json({ success: true });
    } catch (error: any) {
      logger.error('[Conversations] Update failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // DELETE /:id - Delete conversation
  router.delete('/:id', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const deleted = await conversationService.deleteConversation(req.params.id as string, userId);
      if (!deleted) return res.status(404).json({ error: 'Conversation not found' });

      res.json({ success: true });
    } catch (error: any) {
      logger.error('[Conversations] Delete failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /:id/messages - Add message
  router.post('/:id/messages', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { role, content, thinking_steps, decisions, citations, documents, tool_calls, cost_tracking_id, cost_summary } = req.body;
      if (!role || !content) return res.status(400).json({ error: 'role and content required' });

      const message = await conversationService.addMessage(req.params.id as string, userId, {
        role,
        content,
        thinking_steps,
        decisions,
        citations,
        documents,
        tool_calls,
        cost_tracking_id,
        cost_summary,
      });

      if (!message) return res.status(404).json({ error: 'Conversation not found' });
      res.status(201).json(message);
    } catch (error: any) {
      logger.error('[Conversations] Add message failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /:id/messages - Get messages (paginated)
  router.get('/:id/messages', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;

      const messages = await conversationService.getMessages(req.params.id as string, userId, { limit, offset });
      res.json({ messages });
    } catch (error: any) {
      logger.error('[Conversations] Get messages failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  return router;
}
