/**
 * User Preferences Service
 * Manages user request preferences for cost and quality control
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

export type ReasoningBudget = 'quick' | 'standard' | 'deep';
export type QualityPreference = 'economy' | 'balanced' | 'quality';

export interface UserRequestPreferences {
  id: string;
  user_id: string;

  // Reasoning/Analysis Settings
  default_reasoning_budget: ReasoningBudget;

  // Document Retrieval Limits
  max_search_results: number; // 1-50
  max_analysis_depth: number; // 1-5
  max_practice_cases: number; // 3-25
  max_practice_depth: number; // 1-5

  // Cost vs Quality Trade-off
  quality_preference: QualityPreference;

  // Caching Settings
  aggressive_caching: boolean;

  // Feature Toggles
  enable_semantic_search: boolean;
  enable_auto_citations: boolean;
  enable_legal_patterns: boolean;

  created_at: Date;
  updated_at: Date;
}

export interface PresetConfig {
  preset_name: QualityPreference;
  description: string;
  reasoning_budget: ReasoningBudget;
  max_search_results: number;
  max_analysis_depth: number;
  max_practice_cases: number;
  max_practice_depth: number;
  aggressive_caching: boolean;
  enable_semantic_search: boolean;
  estimated_cost_multiplier: number;
}

export interface CostEstimate {
  preset: QualityPreference;
  estimated_cost_usd: number;
  estimated_tokens: number;
  estimated_api_calls: number;
  breakdown: {
    openai_tokens: number;
    zakononline_calls: number;
    secondlayer_docs: number;
  };
}

export class UserPreferencesService {
  constructor(private db: Database) {}

  /**
   * Get user preferences (with defaults if not set)
   */
  async getUserPreferences(userId: string): Promise<UserRequestPreferences> {
    try {
      const result = await this.db.query(
        'SELECT * FROM user_request_preferences WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length > 0) {
        return result.rows[0] as UserRequestPreferences;
      }

      // Return defaults if not found
      return this.getDefaultPreferences(userId);
    } catch (error: any) {
      logger.error('Failed to get user preferences', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get default preferences for a user
   */
  private getDefaultPreferences(userId: string): UserRequestPreferences {
    return {
      id: '',
      user_id: userId,
      default_reasoning_budget: 'standard',
      max_search_results: 10,
      max_analysis_depth: 2,
      max_practice_cases: 15,
      max_practice_depth: 2,
      quality_preference: 'balanced',
      aggressive_caching: true,
      enable_semantic_search: true,
      enable_auto_citations: true,
      enable_legal_patterns: false,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  /**
   * Create or update user preferences
   */
  async upsertPreferences(
    userId: string,
    preferences: Partial<Omit<UserRequestPreferences, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
  ): Promise<UserRequestPreferences> {
    try {
      // Validate values
      this.validatePreferences(preferences);

      const result = await this.db.query(
        `INSERT INTO user_request_preferences (
          user_id,
          default_reasoning_budget,
          max_search_results,
          max_analysis_depth,
          max_practice_cases,
          max_practice_depth,
          quality_preference,
          aggressive_caching,
          enable_semantic_search,
          enable_auto_citations,
          enable_legal_patterns,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          default_reasoning_budget = COALESCE($2, user_request_preferences.default_reasoning_budget),
          max_search_results = COALESCE($3, user_request_preferences.max_search_results),
          max_analysis_depth = COALESCE($4, user_request_preferences.max_analysis_depth),
          max_practice_cases = COALESCE($5, user_request_preferences.max_practice_cases),
          max_practice_depth = COALESCE($6, user_request_preferences.max_practice_depth),
          quality_preference = COALESCE($7, user_request_preferences.quality_preference),
          aggressive_caching = COALESCE($8, user_request_preferences.aggressive_caching),
          enable_semantic_search = COALESCE($9, user_request_preferences.enable_semantic_search),
          enable_auto_citations = COALESCE($10, user_request_preferences.enable_auto_citations),
          enable_legal_patterns = COALESCE($11, user_request_preferences.enable_legal_patterns),
          updated_at = NOW()
        RETURNING *`,
        [
          userId,
          preferences.default_reasoning_budget,
          preferences.max_search_results,
          preferences.max_analysis_depth,
          preferences.max_practice_cases,
          preferences.max_practice_depth,
          preferences.quality_preference,
          preferences.aggressive_caching,
          preferences.enable_semantic_search,
          preferences.enable_auto_citations,
          preferences.enable_legal_patterns,
        ]
      );

      logger.info('User preferences updated', {
        userId,
        preferences,
      });

      return result.rows[0] as UserRequestPreferences;
    } catch (error: any) {
      logger.error('Failed to upsert user preferences', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Apply a preset configuration to user preferences
   */
  async applyPreset(userId: string, presetName: QualityPreference): Promise<UserRequestPreferences> {
    try {
      const preset = await this.getPresetConfig(presetName);

      if (!preset) {
        throw new Error(`Preset not found: ${presetName}`);
      }

      return await this.upsertPreferences(userId, {
        default_reasoning_budget: preset.reasoning_budget,
        max_search_results: preset.max_search_results,
        max_analysis_depth: preset.max_analysis_depth,
        max_practice_cases: preset.max_practice_cases,
        max_practice_depth: preset.max_practice_depth,
        quality_preference: presetName,
        aggressive_caching: preset.aggressive_caching,
        enable_semantic_search: preset.enable_semantic_search,
      });
    } catch (error: any) {
      logger.error('Failed to apply preset', {
        userId,
        presetName,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get all available preset configurations
   */
  async getAllPresets(): Promise<PresetConfig[]> {
    try {
      const result = await this.db.query(
        'SELECT * FROM request_preset_configs ORDER BY estimated_cost_multiplier ASC'
      );
      return result.rows as PresetConfig[];
    } catch (error: any) {
      logger.error('Failed to get presets', { error: error.message });
      throw error;
    }
  }

  /**
   * Get a specific preset configuration
   */
  async getPresetConfig(presetName: QualityPreference): Promise<PresetConfig | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM request_preset_configs WHERE preset_name = $1',
        [presetName]
      );
      return result.rows[0] as PresetConfig || null;
    } catch (error: any) {
      logger.error('Failed to get preset config', {
        presetName,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Estimate cost for different presets
   */
  async estimateCostsForPresets(queryLength: number = 100): Promise<CostEstimate[]> {
    const presets = await this.getAllPresets();
    const baseTokens = Math.floor(queryLength / 4); // ~4 chars per token

    return presets.map((preset) => {
      // Estimate OpenAI tokens
      const searchTokens = preset.max_search_results * 200; // avg tokens per doc snippet
      const analysisTokens = preset.max_analysis_depth * 1000; // tokens per depth level
      const practiceTokens = preset.max_practice_cases * 500; // tokens per practice case
      const reasoningMultiplier = preset.reasoning_budget === 'deep' ? 2.0 : preset.reasoning_budget === 'quick' ? 0.5 : 1.0;

      const totalTokens = Math.floor(
        (baseTokens + searchTokens + analysisTokens + practiceTokens) * reasoningMultiplier
      );

      // Estimate API calls
      const zakononlineCalls = Math.ceil(preset.max_search_results / 10); // ~10 results per API call
      const secondlayerDocs = preset.enable_semantic_search ? preset.max_search_results : 0;

      // Estimate costs (using pricing from cost-tracker.ts)
      const openaiCost = (totalTokens / 1000) * 0.002; // $0.002 per 1k tokens average
      const zakononlineCost = zakononlineCalls * 0.00714;
      const secondlayerCost = secondlayerDocs * 0.00714;

      const totalCost = openaiCost + zakononlineCost + secondlayerCost;

      return {
        preset: preset.preset_name,
        estimated_cost_usd: Number(totalCost.toFixed(6)),
        estimated_tokens: totalTokens,
        estimated_api_calls: zakononlineCalls + secondlayerDocs,
        breakdown: {
          openai_tokens: totalTokens,
          zakononline_calls: zakononlineCalls,
          secondlayer_docs: secondlayerDocs,
        },
      };
    });
  }

  /**
   * Validate preference values
   */
  private validatePreferences(
    preferences: Partial<Omit<UserRequestPreferences, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
  ): void {
    if (preferences.max_search_results !== undefined) {
      if (preferences.max_search_results < 1 || preferences.max_search_results > 50) {
        throw new Error('max_search_results must be between 1 and 50');
      }
    }

    if (preferences.max_analysis_depth !== undefined) {
      if (preferences.max_analysis_depth < 1 || preferences.max_analysis_depth > 5) {
        throw new Error('max_analysis_depth must be between 1 and 5');
      }
    }

    if (preferences.max_practice_cases !== undefined) {
      if (preferences.max_practice_cases < 3 || preferences.max_practice_cases > 25) {
        throw new Error('max_practice_cases must be between 3 and 25');
      }
    }

    if (preferences.max_practice_depth !== undefined) {
      if (preferences.max_practice_depth < 1 || preferences.max_practice_depth > 5) {
        throw new Error('max_practice_depth must be between 1 and 5');
      }
    }

    if (preferences.default_reasoning_budget !== undefined) {
      if (!['quick', 'standard', 'deep'].includes(preferences.default_reasoning_budget)) {
        throw new Error('default_reasoning_budget must be quick, standard, or deep');
      }
    }

    if (preferences.quality_preference !== undefined) {
      if (!['economy', 'balanced', 'quality'].includes(preferences.quality_preference)) {
        throw new Error('quality_preference must be economy, balanced, or quality');
      }
    }
  }

  /**
   * Get combined user settings (billing + preferences)
   */
  async getUserFullSettings(userId: string): Promise<any> {
    try {
      const result = await this.db.query(
        'SELECT * FROM user_full_settings WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error: any) {
      logger.error('Failed to get user full settings', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }
}
