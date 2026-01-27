/**
 * Voting Service
 * Handles voting records and AI-powered voting pattern analysis
 */

import { Database } from '../database/database';
import { logger } from '../utils/logger';
import { RadaAPIAdapter } from '../adapters/rada-api-adapter';
import { getLLMManager } from '../utils/llm-client-manager';
import { v4 as uuidv4 } from 'uuid';
import {
  VotingRecord,
  VotingAnalysisParams,
  VotingStatistics,
  VotingPosition,
  VotingPattern,
  VoteType,
} from '../types';

export class VotingService {
  constructor(
    private db: Database,
    private radaAdapter: RadaAPIAdapter
  ) {
    logger.info('VotingService initialized');
  }

  /**
   * Validate date format (YYYY-MM-DD)
   */
  private validateDateFormat(dateString: string): boolean {
    // Check format with regex
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateString)) {
      return false;
    }

    // Check if it's a valid date
    const date = new Date(dateString);
    const timestamp = date.getTime();

    // Check if date is valid (not NaN) and matches the input
    if (isNaN(timestamp)) {
      return false;
    }

    // Verify the date components match (prevents cases like 2024-02-30)
    const [year, month, day] = dateString.split('-').map(Number);
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }

  /**
   * Get voting records for a specific date
   */
  async getVotingByDate(
    date: string,
    convocation: number = 9,
    forceRefresh: boolean = false
  ): Promise<VotingRecord[]> {
    try {
      // Step 1: Check cache if not forcing refresh
      if (!forceRefresh) {
        const cached = await this.getCachedVoting(date);
        if (cached.length > 0) {
          logger.debug('Voting records found in cache', { date, count: cached.length });
          return cached;
        }
      }

      // Step 2: Fetch from RADA API
      logger.info('Fetching voting records from RADA API', { date, convocation });
      const rawVoting = await this.radaAdapter.fetchVoting(date, convocation);

      // Step 3: Transform and save to database
      const votingRecords: VotingRecord[] = [];
      for (const raw of rawVoting) {
        const record = this.transformRawVoting(raw, date);
        await this.saveVotingRecord(record);
        votingRecords.push(record);
      }

      return votingRecords;
    } catch (error: any) {
      logger.error('Failed to get voting by date', {
        date,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Analyze deputy voting patterns with AI
   */
  async analyzeVotingRecord(
    params: VotingAnalysisParams
  ): Promise<VotingStatistics> {
    try {
      // Validate date parameters
      if (params.date_from && !this.validateDateFormat(params.date_from)) {
        throw new Error(
          `Invalid date_from format: "${params.date_from}". Expected YYYY-MM-DD (e.g., 2024-01-15)`
        );
      }

      if (params.date_to && !this.validateDateFormat(params.date_to)) {
        throw new Error(
          `Invalid date_to format: "${params.date_to}". Expected YYYY-MM-DD (e.g., 2024-12-31)`
        );
      }

      logger.info('Analyzing voting record', { params });

      // Step 1: Get all voting positions for the deputy
      const positions = await this.getDeputyVotingPositions(
        params.deputy_name,
        params.date_from,
        params.date_to,
        params.bill_number
      );

      if (positions.length === 0) {
        logger.warn('No voting positions found for deputy', {
          deputyName: params.deputy_name,
        });
        return this.createEmptyStatistics();
      }

      // Step 2: Calculate basic statistics
      const stats = this.calculateStatistics(positions);

      // Step 3: If pattern analysis requested, use AI
      if (params.analyze_patterns) {
        stats.patterns = await this.analyzeVotingPatterns(positions);
      }

      logger.info('Voting analysis completed', {
        deputyName: params.deputy_name,
        totalVotes: stats.total_votes,
        patternsFound: stats.patterns?.length || 0,
      });

      return stats;
    } catch (error: any) {
      logger.error('Failed to analyze voting record', {
        params,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get deputy voting positions
   */
  private async getDeputyVotingPositions(
    deputyName: string,
    dateFrom?: string,
    dateTo?: string,
    billNumber?: string
  ): Promise<VotingPosition[]> {
    try {
      // First, find the deputy's RADA ID
      const deputyQuery = `
        SELECT rada_id FROM deputies
        WHERE full_name ILIKE $1 OR short_name ILIKE $1
        LIMIT 1
      `;
      const deputyResult = await this.db.query(deputyQuery, [`%${deputyName}%`]);

      if (deputyResult.rows.length === 0) {
        logger.warn('Deputy not found in database', { deputyName });
        return [];
      }

      const radaId = deputyResult.rows[0].rada_id;

      // Build query for voting records
      let query = `
        SELECT
          session_date,
          question_text,
          bill_number,
          result,
          votes
        FROM voting_records
        WHERE votes ? $1
      `;
      const params: any[] = [radaId];
      let paramIndex = 2;

      if (dateFrom) {
        query += ` AND session_date >= $${paramIndex}`;
        params.push(dateFrom);
        paramIndex++;
      }

      if (dateTo) {
        query += ` AND session_date <= $${paramIndex}`;
        params.push(dateTo);
        paramIndex++;
      }

      if (billNumber) {
        query += ` AND bill_number = $${paramIndex}`;
        params.push(billNumber);
        paramIndex++;
      }

      query += ' ORDER BY session_date DESC LIMIT 500';

      const result = await this.db.query(query, params);

      // Extract positions
      const positions: VotingPosition[] = [];
      for (const row of result.rows) {
        const votes = row.votes || {};
        const vote = votes[radaId] as VoteType;

        if (vote) {
          positions.push({
            date: row.session_date,
            question: row.question_text || 'Невідоме питання',
            bill_number: row.bill_number,
            vote,
            result: row.result,
          });
        }
      }

      return positions;
    } catch (error: any) {
      logger.error('Failed to get deputy voting positions', {
        deputyName,
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Calculate basic voting statistics
   */
  private calculateStatistics(positions: VotingPosition[]): VotingStatistics {
    const stats: VotingStatistics = {
      total_votes: positions.length,
      voted_for: 0,
      voted_against: 0,
      abstained: 0,
      not_present: 0,
      attendance_rate: 0,
      positions,
    };

    for (const pos of positions) {
      if (pos.vote === 'За') stats.voted_for++;
      else if (pos.vote === 'Проти') stats.voted_against++;
      else if (pos.vote === 'Утримався') stats.abstained++;
      else if (pos.vote === 'Не голосував') stats.not_present++;
    }

    // Calculate attendance rate (present = voted_for + voted_against + abstained)
    const present = stats.voted_for + stats.voted_against + stats.abstained;
    stats.attendance_rate =
      stats.total_votes > 0 ? (present / stats.total_votes) * 100 : 0;

    return stats;
  }

  /**
   * Analyze voting patterns using AI
   */
  private async analyzeVotingPatterns(
    positions: VotingPosition[]
  ): Promise<VotingPattern[]> {
    try {
      const llmManager = getLLMManager();

      // Prepare voting data for AI analysis
      const votingSummary = positions.slice(0, 50).map((p) => ({
        date: p.date,
        question: p.question.slice(0, 100),
        vote: p.vote,
        result: p.result,
      }));

      const prompt = `
Analyze the following voting record and identify patterns:

Voting History:
${JSON.stringify(votingSummary, null, 2)}

Please identify:
1. Consistency patterns (e.g., always votes with majority/minority)
2. Topic-based patterns (e.g., votes differently on specific types of bills)
3. Time-based patterns (e.g., voting behavior changes over time)
4. Abstention patterns (e.g., frequently abstains on controversial topics)

Return a JSON array of patterns with this structure:
[
  {
    "pattern_type": "consistency" | "topic_based" | "time_based" | "abstention",
    "description": "Brief description of the pattern",
    "frequency": number (0-100, how often this pattern appears),
    "confidence": number (0-1, how confident you are in this pattern),
    "examples": ["example1", "example2"]
  }
]

Only return the JSON array, no additional text.
      `.trim();

      const response = await llmManager.chatCompletion(
        {
          messages: [
            {
              role: 'system',
              content:
                'You are a political analyst specializing in Ukrainian parliamentary voting patterns.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        },
        'standard'
      );

      // Parse patterns from response
      const parsed = JSON.parse(response.content);
      const patterns: VotingPattern[] = Array.isArray(parsed)
        ? parsed
        : parsed.patterns || [];

      logger.info('AI voting pattern analysis completed', {
        patternsFound: patterns.length,
        model: response.model,
      });

      return patterns;
    } catch (error: any) {
      logger.error('Failed to analyze voting patterns with AI', {
        error: error.message,
      });
      // Return empty patterns on error
      return [];
    }
  }

  /**
   * Get cached voting records for a date
   */
  private async getCachedVoting(date: string): Promise<VotingRecord[]> {
    try {
      const result = await this.db.query(
        'SELECT * FROM voting_records WHERE session_date = $1 ORDER BY question_number ASC',
        [date]
      );

      return result.rows as VotingRecord[];
    } catch (error: any) {
      logger.error('Failed to get cached voting', {
        date,
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Save voting record to database
   */
  private async saveVotingRecord(record: VotingRecord): Promise<string> {
    try {
      const id = record.id || uuidv4();

      const query = `
        INSERT INTO voting_records (
          id, session_date, session_number, question_number,
          question_text, bill_number, question_type,
          total_voted, voted_for, voted_against, voted_abstain, voted_not_present,
          result, votes, metadata, created_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, NOW()
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;

      const result = await this.db.query(query, [
        id,
        record.session_date,
        record.session_number || null,
        record.question_number || null,
        record.question_text || null,
        record.bill_number || null,
        record.question_type || null,
        record.total_voted || null,
        record.voted_for || null,
        record.voted_against || null,
        record.voted_abstain || null,
        record.voted_not_present || null,
        record.result || null,
        JSON.stringify(record.votes || {}),
        JSON.stringify(record.metadata || {}),
      ]);

      const savedId = result.rows.length > 0 ? result.rows[0].id : id;

      logger.debug('Voting record saved', {
        date: record.session_date,
        questionNumber: record.question_number,
        id: savedId,
      });

      return savedId;
    } catch (error: any) {
      logger.error('Failed to save voting record', {
        date: record.session_date,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Transform raw RADA API data to VotingRecord type
   */
  private transformRawVoting(raw: any, date: string): VotingRecord {
    return {
      id: uuidv4(),
      session_date: new Date(date),
      session_number: raw.session || raw.session_number || null,
      question_number: raw.question_number || raw.question || null,
      question_text: raw.question_text || raw.text || null,
      bill_number: raw.bill_number || null,
      question_type: raw.type || raw.question_type || null,
      total_voted: raw.total || null,
      voted_for: raw.for || null,
      voted_against: raw.against || null,
      voted_abstain: raw.abstain || null,
      voted_not_present: raw.not_present || null,
      result: raw.result || null,
      votes: raw.votes || {},
      metadata: raw,
    };
  }

  /**
   * Create empty statistics
   */
  private createEmptyStatistics(): VotingStatistics {
    return {
      total_votes: 0,
      voted_for: 0,
      voted_against: 0,
      abstained: 0,
      not_present: 0,
      attendance_rate: 0,
      positions: [],
    };
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<any> {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(*) as total_voting_records,
          COUNT(DISTINCT session_date) as unique_dates,
          COUNT(DISTINCT bill_number) as bills_voted_on,
          MIN(session_date) as earliest_vote,
          MAX(session_date) as latest_vote,
          AVG(total_voted) as avg_votes_per_question
        FROM voting_records
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to get voting stats:', error);
      return null;
    }
  }
}
