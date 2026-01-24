/**
 * Cross-Reference Service
 * Links RADA parliament data with SecondLayer court cases
 */

import { Database } from '../database/database';
import { logger } from '../utils/logger';
import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { LawCourtCitation, BillCourtImpact } from '../types';

export class CrossReferenceService {
  private secondLayerClient: AxiosInstance;
  private secondLayerUrl: string;
  private secondLayerApiKey: string;

  constructor(private db: Database) {
    this.secondLayerUrl =
      process.env.SECONDLAYER_URL || 'http://localhost:3000';
    this.secondLayerApiKey = process.env.SECONDLAYER_API_KEY || '';

    this.secondLayerClient = axios.create({
      baseURL: this.secondLayerUrl,
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${this.secondLayerApiKey}`,
        'Content-Type': 'application/json',
      },
    });

    logger.info('CrossReferenceService initialized', {
      secondLayerUrl: this.secondLayerUrl,
      hasApiKey: !!this.secondLayerApiKey,
    });
  }

  /**
   * Sync court citations for a law from SecondLayer
   */
  async syncCourtCitations(lawNumber: string, article?: string): Promise<number> {
    try {
      logger.info('Syncing court citations from SecondLayer', {
        lawNumber,
        article,
      });

      // Call SecondLayer API to find cases citing this law
      const response = await this.secondLayerClient.post('/api/tools/find_relevant_law_articles', {
        topic: `закон ${lawNumber}${article ? ` стаття ${article}` : ''}`,
        limit: 100,
      });

      if (!response.data || !response.data.content) {
        logger.warn('No content in SecondLayer response', { lawNumber });
        return 0;
      }

      // Parse response (assuming it returns case data)
      const citationsData = this.parseSecondLayerResponse(response.data.content);

      // Save citations to database
      let syncedCount = 0;
      for (const citation of citationsData) {
        await this.saveCitation({
          law_number: lawNumber,
          law_article: article || citation.article || null,
          court_case_id: citation.case_id || null,
          court_case_number: citation.case_number,
          citation_count: citation.count || 1,
          last_citation_date: citation.date || new Date(),
          citation_context: citation.context || null,
          synced_from_secondlayer: true,
        });
        syncedCount++;
      }

      logger.info('Court citations synced', {
        lawNumber,
        article,
        syncedCount,
      });

      return syncedCount;
    } catch (error: any) {
      logger.error('Failed to sync court citations', {
        lawNumber,
        article,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get court citations for a law
   */
  async getCourtCitations(
    lawNumber: string,
    article?: string
  ): Promise<LawCourtCitation[]> {
    try {
      let query = 'SELECT * FROM law_court_citations WHERE law_number = $1';
      const params: any[] = [lawNumber];

      if (article) {
        query += ' AND law_article = $2';
        params.push(article);
      }

      query += ' ORDER BY citation_count DESC, last_citation_date DESC';

      const result = await this.db.query(query, params);
      return result.rows as LawCourtCitation[];
    } catch (error: any) {
      logger.error('Failed to get court citations', {
        lawNumber,
        article,
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Search SecondLayer for cases related to a bill
   */
  async findRelatedCasesForBill(billNumber: string): Promise<any[]> {
    try {
      logger.info('Searching SecondLayer for cases related to bill', {
        billNumber,
      });

      // Get bill details from database
      const billResult = await this.db.query(
        'SELECT title, subject_area, law_articles FROM bills WHERE bill_number = $1',
        [billNumber]
      );

      if (billResult.rows.length === 0) {
        logger.warn('Bill not found in database', { billNumber });
        return [];
      }

      const bill = billResult.rows[0];

      // Build search query for SecondLayer
      const searchQuery = `законопроект ${billNumber} ${bill.title}`;

      // Call SecondLayer search API
      const response = await this.secondLayerClient.post('/api/tools/search_legal_precedents', {
        query: searchQuery,
        limit: 20,
      });

      if (!response.data || !response.data.content) {
        logger.warn('No content in SecondLayer response for bill', {
          billNumber,
        });
        return [];
      }

      // Parse and return cases
      const cases = this.parseSecondLayerResponse(response.data.content);

      logger.info('Related cases found for bill', {
        billNumber,
        casesCount: cases.length,
      });

      return cases;
    } catch (error: any) {
      logger.error('Failed to find related cases for bill', {
        billNumber,
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Analyze bill impact on court cases (AI-powered)
   */
  async analyzeBillImpact(
    billNumber: string,
    relatedLawNumber?: string
  ): Promise<BillCourtImpact | null> {
    try {
      logger.info('Analyzing bill impact on court cases', {
        billNumber,
        relatedLawNumber,
      });

      // Find related cases
      const relatedCases = await this.findRelatedCasesForBill(billNumber);

      if (relatedCases.length === 0) {
        logger.info('No related cases found for impact analysis', {
          billNumber,
        });
        return null;
      }

      // Build impact record
      const impact: BillCourtImpact = {
        id: uuidv4(),
        bill_number: billNumber,
        related_law_number: relatedLawNumber || undefined,
        affected_cases_count: relatedCases.length,
        affected_cases: relatedCases.map((c) => ({
          case_number: c.case_number,
          relevance_score: c.relevance || 0.5,
        })),
        impact_analysis: `Знайдено ${relatedCases.length} судових справ, які можуть бути пов'язані з цим законопроектом.`,
        impact_score: Math.min(relatedCases.length / 100, 1.0),
        analyst: 'cross-reference-service',
      };

      // Save to database
      await this.saveBillImpact(impact);

      logger.info('Bill impact analysis completed', {
        billNumber,
        affectedCases: impact.affected_cases_count,
        impactScore: impact.impact_score,
      });

      return impact;
    } catch (error: any) {
      logger.error('Failed to analyze bill impact', {
        billNumber,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Get bill impact analysis
   */
  async getBillImpact(billNumber: string): Promise<BillCourtImpact | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM bill_court_impact WHERE bill_number = $1 ORDER BY created_at DESC LIMIT 1',
        [billNumber]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as BillCourtImpact;
    } catch (error: any) {
      logger.error('Failed to get bill impact', {
        billNumber,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Save citation to database
   */
  private async saveCitation(citation: Partial<LawCourtCitation>): Promise<string> {
    try {
      const id = citation.id || uuidv4();

      const query = `
        INSERT INTO law_court_citations (
          id, law_number, law_article, court_case_id, court_case_number,
          citation_count, last_citation_date, citation_context,
          synced_from_secondlayer, last_sync_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, NOW(), NOW(), NOW()
        )
        ON CONFLICT ON CONSTRAINT idx_law_citations_unique
        DO UPDATE SET
          citation_count = law_court_citations.citation_count + 1,
          last_citation_date = COALESCE(EXCLUDED.last_citation_date, law_court_citations.last_citation_date),
          citation_context = COALESCE(EXCLUDED.citation_context, law_court_citations.citation_context),
          synced_from_secondlayer = EXCLUDED.synced_from_secondlayer,
          last_sync_at = NOW(),
          updated_at = NOW()
        RETURNING id
      `;

      const result = await this.db.query(query, [
        id,
        citation.law_number,
        citation.law_article || null,
        citation.court_case_id || null,
        citation.court_case_number,
        citation.citation_count || 1,
        citation.last_citation_date || new Date(),
        citation.citation_context || null,
        citation.synced_from_secondlayer !== undefined
          ? citation.synced_from_secondlayer
          : true,
      ]);

      const savedId = result.rows[0].id;

      logger.debug('Citation saved', {
        law_number: citation.law_number,
        case_number: citation.court_case_number,
        id: savedId,
      });

      return savedId;
    } catch (error: any) {
      logger.error('Failed to save citation', {
        citation,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Save bill impact analysis
   */
  private async saveBillImpact(impact: BillCourtImpact): Promise<string> {
    try {
      const id = impact.id || uuidv4();

      const query = `
        INSERT INTO bill_court_impact (
          id, bill_number, related_law_number,
          affected_cases_count, affected_cases,
          impact_analysis, impact_score, analyst,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3,
          $4, $5,
          $6, $7, $8,
          NOW(), NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          affected_cases_count = EXCLUDED.affected_cases_count,
          affected_cases = EXCLUDED.affected_cases,
          impact_analysis = EXCLUDED.impact_analysis,
          impact_score = EXCLUDED.impact_score,
          analyst = EXCLUDED.analyst,
          updated_at = NOW()
        RETURNING id
      `;

      const result = await this.db.query(query, [
        id,
        impact.bill_number,
        impact.related_law_number || null,
        impact.affected_cases_count,
        JSON.stringify(impact.affected_cases || []),
        impact.impact_analysis || null,
        impact.impact_score || null,
        impact.analyst || 'unknown',
      ]);

      const savedId = result.rows[0].id;

      logger.debug('Bill impact saved', {
        bill_number: impact.bill_number,
        id: savedId,
      });

      return savedId;
    } catch (error: any) {
      logger.error('Failed to save bill impact', {
        impact,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Parse SecondLayer API response
   * This is a helper method that tries to extract structured data from response
   */
  private parseSecondLayerResponse(content: any): any[] {
    try {
      // If content is array of objects with text
      if (Array.isArray(content)) {
        const results: any[] = [];
        for (const item of content) {
          if (item.type === 'text' && item.text) {
            // Try to extract case numbers from text
            const caseNumberMatch = item.text.match(/№?\s*(\d{3,4}\/\d{2,4}\/\d{2,4})/);
            if (caseNumberMatch) {
              results.push({
                case_number: caseNumberMatch[1],
                context: item.text.slice(0, 200),
              });
            }
          }
        }
        return results;
      }

      // If content is single text object
      if (content.type === 'text' && content.text) {
        const caseNumbers = content.text.matchAll(/№?\s*(\d{3,4}\/\d{2,4}\/\d{2,4})/g);
        const results: any[] = [];
        for (const match of caseNumbers) {
          results.push({
            case_number: match[1],
            context: content.text.slice(Math.max(0, match.index! - 100), match.index! + 100),
          });
        }
        return results;
      }

      // Try JSON parse if string
      if (typeof content === 'string') {
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          // Not JSON, continue
        }
      }

      return [];
    } catch (error: any) {
      logger.error('Failed to parse SecondLayer response', {
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Health check for SecondLayer connection
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.secondLayerClient.get('/health');
      return response.status === 200;
    } catch (error) {
      logger.error('SecondLayer health check failed:', error);
      return false;
    }
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<any> {
    try {
      const citationsResult = await this.db.query(`
        SELECT
          COUNT(*) as total_citations,
          COUNT(DISTINCT law_number) as unique_laws,
          COUNT(DISTINCT court_case_number) as unique_cases,
          COUNT(CASE WHEN synced_from_secondlayer = true THEN 1 END) as synced_citations,
          MAX(last_sync_at) as last_sync
        FROM law_court_citations
      `);

      const impactResult = await this.db.query(`
        SELECT
          COUNT(*) as total_impact_analyses,
          COUNT(DISTINCT bill_number) as unique_bills,
          SUM(affected_cases_count) as total_affected_cases,
          AVG(impact_score) as avg_impact_score
        FROM bill_court_impact
      `);

      return {
        citations: citationsResult.rows[0],
        impact: impactResult.rows[0],
      };
    } catch (error) {
      logger.error('Failed to get cross-reference stats:', error);
      return null;
    }
  }
}
