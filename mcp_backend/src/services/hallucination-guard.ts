import { Database } from '../database/database.js';
import { ValidationResult } from '../types/index.js';

export class HallucinationGuard {
  constructor(
    private db: Database
  ) {}

  async validateResponse(
    response: any,
    sources: string[]
  ): Promise<ValidationResult> {
    const claims_without_sources: string[] = [];
    const invalid_citations: string[] = [];
    const warnings: string[] = [];

    // Extract claims from response
    const claims = this.extractClaims(response);

    // Validate each claim
    for (const claim of claims) {
      const hasSource = this.hasSource(claim, sources);
      if (!hasSource) {
        claims_without_sources.push(claim);
      }

      // Check for citations
      const citations = this.extractCitations(claim);
      for (const citation of citations) {
        const isValid = await this.validateCitation(citation);
        if (!isValid) {
          invalid_citations.push(citation);
        }
      }
    }

    // Check law articles
    const lawArticles = this.extractLawArticles(response);
    for (const article of lawArticles) {
      const isValid = await this.validateLawArticle(article);
      if (!isValid) {
        warnings.push(`Law article ${article} may be invalid or outdated`);
      }
    }

    const is_valid = claims_without_sources.length === 0 && invalid_citations.length === 0;
    const confidence = this.calculateConfidence(
      claims.length,
      claims_without_sources.length,
      invalid_citations.length
    );

    return {
      is_valid,
      claims_without_sources,
      invalid_citations,
      confidence,
      warnings,
    };
  }

  async verifyClaim(claim: string, sources: string[]): Promise<boolean> {
    // Check if claim mentions any source
    for (const source of sources) {
      if (claim.toLowerCase().includes(source.toLowerCase())) {
        return true;
      }
    }

    // Try to find claim in database
    const found = await this.db.query(
      `SELECT id FROM documents 
       WHERE full_text ILIKE $1 OR title ILIKE $1
       LIMIT 1`,
      [`%${claim.substring(0, 100)}%`]
    );

    return found.rows.length > 0;
  }

  private extractClaims(response: any): string[] {
    const claims: string[] = [];

    if (typeof response === 'string') {
      // Simple sentence splitting
      const sentences = response.split(/[.!?]+/).filter((s) => s.trim().length > 20);
      claims.push(...sentences);
    } else if (typeof response === 'object') {
      // Extract from structured response
      if (response.summary) {
        claims.push(...this.extractClaims(response.summary));
      }
      if (response.explanation) {
        if (response.explanation.why_relevant) {
          claims.push(response.explanation.why_relevant);
        }
        if (response.explanation.key_factors) {
          claims.push(...response.explanation.key_factors);
        }
      }
    }

    return claims.filter((c) => c.trim().length > 0);
  }

  private hasSource(claim: string, sources: string[]): boolean {
    for (const source of sources) {
      if (claim.includes(source) || claim.includes('джерело') || claim.includes('посилання')) {
        return true;
      }
    }
    return false;
  }

  private extractCitations(text: string): string[] {
    const citations: string[] = [];
    
    // Case number patterns
    const casePattern = /\d+\/\d+\/\d{4}/g;
    const matches = text.matchAll(casePattern);
    for (const match of matches) {
      citations.push(match[0]);
    }

    return citations;
  }

  private async validateCitation(citation: string): Promise<boolean> {
    // Check if citation exists in database
    const result = await this.db.query(
      `SELECT id FROM documents 
       WHERE zakononline_id LIKE $1 OR metadata->>'case_number' = $2
       LIMIT 1`,
      [`%${citation}%`, citation]
    );

    return result.rows.length > 0;
  }

  private extractLawArticles(text: string): string[] {
    const articles: string[] = [];
    const articlePattern = /ст\.\s*\d+/gi;
    const matches = text.matchAll(articlePattern);
    for (const match of matches) {
      articles.push(match[0]);
    }
    return [...new Set(articles)];
  }

  private async validateLawArticle(article: string): Promise<boolean> {
    // Basic validation - check if article format is correct
    // In production, this would check against actual law database
    return /ст\.\s*\d+/.test(article);
  }

  private calculateConfidence(
    totalClaims: number,
    claimsWithoutSources: number,
    invalidCitations: number
  ): number {
    if (totalClaims === 0) return 1.0;

    const sourceScore = 1.0 - claimsWithoutSources / totalClaims;
    const citationScore = 1.0 - invalidCitations / Math.max(totalClaims, 1);

    return (sourceScore + citationScore) / 2;
  }
}
