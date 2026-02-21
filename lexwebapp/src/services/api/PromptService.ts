/**
 * Prompt Service - HTTP client for saved user prompts
 */

import { BaseService } from '../base/BaseService';

export interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  is_favorite: boolean;
  created_at: string;
}

export class PromptService extends BaseService {
  async list(): Promise<SavedPrompt[]> {
    try {
      const response = await this.client.get<{ prompts: SavedPrompt[] }>('/api/prompts');
      return response.data.prompts;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async save(name: string, content: string): Promise<SavedPrompt> {
    try {
      const response = await this.client.post<{ prompt: SavedPrompt }>('/api/prompts', { name, content });
      return response.data.prompt;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async toggleFavorite(id: string): Promise<{ id: string; is_favorite: boolean }> {
    try {
      const response = await this.client.patch<{ prompt: { id: string; is_favorite: boolean } }>(`/api/prompts/${id}/favorite`);
      return response.data.prompt;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.client.delete(`/api/prompts/${id}`);
    } catch (error) {
      return this.handleError(error);
    }
  }
}

export const promptService = new PromptService();
