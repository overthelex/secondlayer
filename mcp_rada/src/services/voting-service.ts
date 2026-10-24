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

const VOTE_TYPES: VoteType[] = ['За', 'Проти', 'Утримався', 'Не голосував', 'Відсутній'];

const VOTE_CODES: Record<number, VoteType> = {
  0: 'Відсутній',
  1: 'За',
  2: 'Проти',
  3: 'Утримався',
  4: 'Не голосував',
};

function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

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
      // Each raw item is a "question" which may contain multiple voting events
      const votingRecords: VotingRecord[] = [];
      for (const raw of rawVoting) {
        const records = VotingService.transformRawQuestion(raw, date);
        for (const record of records) {
          await this.saveVotingRecord(record);
          votingRecords.push(record);
        }
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

      // Only this deputy's vote is pulled out of the jsonb map, so the whole
      // period is counted (the old LIMIT 500 truncated a busy half-year).
      let query = `
        SELECT
          session_date,
          question_text,
          bill_number,
          result,
          votes ->> $1 AS vote
        FROM voting_records
        WHERE votes ? $1
      `;
      const params: any[] = [String(radaId)];
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

      query += ' ORDER BY session_date DESC, event_id DESC NULLS LAST';

      const result = await this.db.query(query, params);

      const positions: VotingPosition[] = [];
      for (const row of result.rows) {
        const vote = VotingService.toVoteType(row.vote);
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
      else if (pos.vote === 'Не голосував' || pos.vote === 'Відсутній') stats.not_present++;
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

      // question_number / event_id are BIGINT (migration 011), which pg returns as strings
      return result.rows.map((row: any) => ({
        ...row,
        question_number: row.question_number == null ? row.question_number : Number(row.question_number),
        event_id: row.event_id == null ? row.event_id : Number(row.event_id),
      })) as VotingRecord[];
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

      // Roll-calls are keyed by RADA id_event; a question without a roll-call
      // keeps the (session_date, question_number) key (migration 010).
      const conflictTarget = record.event_id
        ? '(event_id) WHERE event_id IS NOT NULL'
        : '(session_date, question_number) WHERE question_number IS NOT NULL AND event_id IS NULL';

      const query = `
        INSERT INTO voting_records (
          id, session_date, session_number, question_number, event_id,
          question_text, bill_number, question_type,
          total_voted, voted_for, voted_against, voted_abstain, voted_not_present,
          result, votes, metadata, created_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, NOW()
        )
        ON CONFLICT ${conflictTarget}
        DO UPDATE SET
          session_date       = EXCLUDED.session_date,
          session_number     = EXCLUDED.session_number,
          question_number    = EXCLUDED.question_number,
          question_text      = EXCLUDED.question_text,
          bill_number        = EXCLUDED.bill_number,
          question_type      = EXCLUDED.question_type,
          total_voted        = EXCLUDED.total_voted,
          voted_for          = EXCLUDED.voted_for,
          voted_against      = EXCLUDED.voted_against,
          voted_abstain      = EXCLUDED.voted_abstain,
          voted_not_present  = EXCLUDED.voted_not_present,
          result             = EXCLUDED.result,
          votes              = EXCLUDED.votes,
          metadata           = EXCLUDED.metadata
        RETURNING id
      `;

      const result = await this.db.query(query, [
        id,
        record.session_date,
        record.session_number || null,
        record.question_number || null,
        record.event_id || null,
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
   * Transform a RADA plenary-day "question" into one VotingRecord per roll-call.
   *
   * Source: data.rada.gov.ua/ogd/zal/ppz/skl9/json/DDMMYYYY.json →
   *   { question: [{ id_question, date_question, event_question: [{
   *       name_event, type_event, result_event: [{ id_event, for, against,
   *       abstain, not_voting, absent, total, voting_result,
   *       result_by_name: [{ id_mp, faction, result }] }] }] }] }
   *
   * A question carries several roll-calls (each amendment, first reading, as a
   * whole), so the record key is id_event, not id_question. Per-deputy votes
   * come as numeric codes keyed by id_mp, which equals deputies.rada_id
   * (LEXAI-2094: the old parser looked for `id`/`voting` strings that the
   * feed never had, so `votes` stayed {} for every row since 2019).
   */
  static transformRawQuestion(raw: any, date: string): VotingRecord[] {
    const records: VotingRecord[] = [];
    const { event_question: _events, ...questionMeta } = raw || {};

    const events = Array.isArray(raw?.event_question) ? raw.event_question : [];
    for (const event of events) {
      const results = Array.isArray(event.result_event) ? event.result_event : [];
      const { result_event: _results, ...eventMeta } = event;
      for (const result of results) {
        const votedFor = toInt(result.for);
        const votedAgainst = toInt(result.against);
        const votedAbstain = toInt(result.abstain);
        const notVoting = toInt(result.not_voting);
        const absent = toInt(result.absent);
        const total = toInt(result.total);

        // Speeches and procedural events come with empty-string tallies
        if (total === 0 && votedFor === 0 && votedAgainst === 0) continue;

        const votes: { [deputyRadaId: string]: VoteType } = {};
        if (Array.isArray(result.result_by_name)) {
          for (const deputy of result.result_by_name) {
            const id = deputy.id_mp ?? deputy.id ?? deputy.deputy_id;
            const vote = VotingService.toVoteType(
              deputy.result ?? deputy.voting ?? deputy.vote
            );
            if (id !== undefined && id !== null && id !== '' && vote) {
              votes[String(id)] = vote;
            }
          }
        }

        const eventId = toInt(result.id_event);
        const questionText = event.name_event || raw.name_question || undefined;
        const { result_by_name: _byName, ...resultMeta } = result;

        records.push({
          session_date: new Date(date),
          question_number: raw.id_question ? Number(raw.id_question) : undefined,
          event_id: eventId || undefined,
          question_text: questionText,
          bill_number: VotingService.extractBillNumber(questionText),
          question_type: event.type_event !== undefined ? String(event.type_event) : undefined,
          total_voted: total || undefined,
          voted_for: votedFor || undefined,
          voted_against: votedAgainst || undefined,
          voted_abstain: votedAbstain || undefined,
          voted_not_present: (notVoting + absent) || undefined,
          result: VotingService.toResultLabel(result.voting_result),
          votes,
          metadata: { question: questionMeta, event: { ...eventMeta, result: resultMeta } },
        });
      }
    }

    // Fallback: a question with no roll-call keeps one row so the agenda is known
    if (records.length === 0 && raw?.id_question) {
      records.push({
        session_date: new Date(date),
        question_number: Number(raw.id_question),
        question_text: raw.name_question || undefined,
        metadata: raw,
      });
    }

    return records;
  }

  /**
   * RADA result_by_name codes, checked against the per-event tallies
   * (e.g. id_event 34191: for 219 = code 1, abstain 19 = code 3,
   * not_voting 67 = code 4, absent 87 = code 0).
   */
  static toVoteType(value: unknown): VoteType | undefined {
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
      return VOTE_CODES[Number(value)];
    }
    if (typeof value === 'string' && (VOTE_TYPES as string[]).includes(value)) {
      return value as VoteType;
    }
    return undefined;
  }

  static toResultLabel(value: unknown): string | undefined {
    if (value === 1 || value === '1') return 'Прийнято';
    if (value === 0 || value === '0') return 'Не прийнято';
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /**
   * Bill number from a roll-call title: «... (№13071)» or «... №13071-д».
   * «поправки №2» is an amendment number, so the parenthesised form wins and
   * otherwise only numbers of 3+ digits count.
   */
  static extractBillNumber(text?: string): string | undefined {
    if (!text) return undefined;
    const BILL = '\\d{3,}(?:-[\\dА-ЯҐЄІЇа-яґєії]+)?(?:/[\\dА-ЯҐЄІЇа-яґєії]+)?';
    const paren = text.match(new RegExp(`\\(\\s*№\\s*(${BILL})\\s*\\)`, 'u'));
    if (paren) return paren[1];
    const all = [...text.matchAll(new RegExp(`№\\s*(${BILL})`, 'gu'))];
    return all.length > 0 ? all[all.length - 1][1] : undefined;
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
