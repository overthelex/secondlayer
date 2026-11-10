/**
 * IncrementalAllowSet — builds allow-sets for case numbers and law articles
 * incrementally during tool execution, not post-hoc from serialized results.
 *
 * Replaces buildAllowedCaseNumbers() + buildAllowedLawArticles() which
 * scanned JSON.stringify'd tool results with regex (fragile, caused PR #20
 * false positives from codes that were never searched).
 *
 * Each tool result is ingested immediately after execution. The set knows
 * exactly what was returned — no guessing from JSON scanning.
 */

import { logger } from '../utils/logger.js';

const CASE_NUMBER_RE = /\d+\/\d+\/\d{2,4}/g;

const LAW_ARTICLE_RE =
  /(?:ст(?:атт[іяє])?\.?\s*)(\d+(?:\.\d+)*)\s*(ЦК|ЦПК|ГК|ГПК|КК|КПК|ПКУ|КАС|КЗпП|КЗПП|СК|ЗК|МК|КУ|КУпАП|КУПАП)?/gi;

const SUBPOINT_RE =
  /(?:п{1,2}\.?\s*)(\d+(?:\.\d+)*)\s*(ЦК|ЦПК|ГК|ГПК|КК|КПК|ПКУ|КАС|КЗпП|КЗПП|СК|ЗК|МК|КУ|КУпАП|КУПАП)?/gi;

const CODE_TO_RADA: Record<string, string> = {
  'ЦК': '435-15', 'ЦПК': '1618-15', 'ГК': '436-15', 'ГПК': '1798-12',
  'КК': '2341-14', 'КПК': '4651-17', 'ПКУ': '2755-17', 'КАС': '2747-15',
  'КЗПП': '322-08', 'КЗпП': '322-08', 'СК': '2947-14', 'ЗК': '2768-14',
  'МК': '4495-17', 'КУ': '254к/96-вр', 'КУпАП': '8073-10', 'КУПАП': '8073-10',
};

function normalizeCaseNumber(n: string): string {
  return n.replace(/\s+/g, '').trim();
}

function normalizeArticleRef(raw: string): string {
  return raw.replace(/\s+/g, '').replace(/\.$/, '').toLowerCase();
}

export class IncrementalAllowSet {
  private caseNumbers = new Set<string>();
  private lawArticles = new Set<string>();
  private searchedRadaIds = new Set<string>();

  /** Snapshot counts for logging */
  get stats() {
    return {
      caseNumbers: this.caseNumbers.size,
      lawArticles: this.lawArticles.size,
      searchedRadaIds: this.searchedRadaIds.size,
    };
  }

  /**
   * Ingest a tool result immediately after execution.
   * Extracts case numbers, law articles, and searched rada_ids
   * from structured fields — not from serialized JSON regex scanning.
   */
  ingestToolResult(toolName: string, result: any): void {
    if (!result) return;

    this.extractCaseNumbersFromResult(result);
    this.extractLawArticlesFromResult(toolName, result);
  }

  /**
   * Ingest case numbers from the user's query.
   * Echoing back user-provided numbers is not fabrication.
   */
  ingestUserQuery(query: string): void {
    CASE_NUMBER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(query)) !== null) {
      this.caseNumbers.add(normalizeCaseNumber(m[0]));
    }

    for (const re of [LAW_ARTICLE_RE, SUBPOINT_RE]) {
      re.lastIndex = 0;
      while ((m = re.exec(query)) !== null) {
        const base = m[1].split('.')[0];
        const code = m[2] || '';
        this.lawArticles.add(normalizeArticleRef(base));
        if (code) this.lawArticles.add(normalizeArticleRef(`${base}:${code.toUpperCase()}`));
      }
    }
  }

  /**
   * Ingest case numbers from cumulative decisions (evidence panel).
   */
  ingestDecisions(decisions: Array<{ number?: string; id?: string }>): void {
    for (const d of decisions) {
      if (d.number) this.caseNumbers.add(normalizeCaseNumber(d.number));
    }
  }

  /**
   * Verify the final answer text. Returns fabricated items.
   */
  verify(answerText: string): {
    fabricatedCaseNumbers: string[];
    fabricatedLawArticles: string[];
  } {
    return {
      fabricatedCaseNumbers: this.findFabricatedCaseNumbers(answerText),
      fabricatedLawArticles: this.findFabricatedLawArticles(answerText),
    };
  }

  /** Allowed case numbers set (for backward compat / testing). */
  get allowedCaseNumbers(): ReadonlySet<string> {
    return this.caseNumbers;
  }

  /** Allowed law articles set (for backward compat / testing). */
  get allowedLawArticles(): ReadonlySet<string> {
    return this.lawArticles;
  }

  /** Searched rada IDs (for backward compat / testing). */
  get allowedRadaIds(): ReadonlySet<string> {
    return this.searchedRadaIds;
  }

  // ---------------------------------------------------------------------------
  // Private: extraction from structured tool results
  // ---------------------------------------------------------------------------

  private extractCaseNumbersFromResult(result: any): void {
    // Structured decisions array (from court tools)
    if (result.decisions && Array.isArray(result.decisions)) {
      for (const d of result.decisions) {
        if (d.number || d.cause_num || d.case_number) {
          this.caseNumbers.add(normalizeCaseNumber(d.number || d.cause_num || d.case_number));
        }
      }
    }

    // MCP content wrapper
    if (result.content && Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          this.extractCaseNumbersFromText(block.text);
        }
      }
      return;
    }

    // Results array (search results)
    if (result.results && Array.isArray(result.results)) {
      for (const r of result.results) {
        if (r.cause_num || r.case_number) {
          this.caseNumbers.add(normalizeCaseNumber(r.cause_num || r.case_number));
        }
      }
    }

    // Grouped documents (case chain)
    if (result.grouped_documents && typeof result.grouped_documents === 'object') {
      for (const docs of Object.values(result.grouped_documents)) {
        if (Array.isArray(docs)) {
          for (const d of docs as any[]) {
            if (d.cause_num || d.case_number) {
              this.caseNumbers.add(normalizeCaseNumber(d.cause_num || d.case_number));
            }
          }
        }
      }
    }

    // Single case_number field
    if (result.case_number) {
      this.caseNumbers.add(normalizeCaseNumber(result.case_number));
    }

    // Full text fields — case numbers mentioned in document body are valid sources
    for (const field of ['full_text', 'text', 'doc_text', 'document_text']) {
      if (typeof result[field] === 'string' && result[field].length > 0) {
        CASE_NUMBER_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CASE_NUMBER_RE.exec(result[field])) !== null) {
          this.caseNumbers.add(normalizeCaseNumber(m[0]));
        }
      }
    }

    // Nested: decisions/results may also carry full text
    const arrays = [result.decisions, result.results];
    for (const arr of arrays) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        for (const field of ['full_text', 'text', 'doc_text']) {
          if (typeof item[field] === 'string' && item[field].length > 0) {
            CASE_NUMBER_RE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = CASE_NUMBER_RE.exec(item[field])) !== null) {
              this.caseNumbers.add(normalizeCaseNumber(m[0]));
            }
          }
        }
      }
    }
  }

  private extractCaseNumbersFromText(text: string): void {
    try {
      const parsed = JSON.parse(text);
      this.extractCaseNumbersFromResult(parsed);
    } catch {
      // Not JSON — scan as raw text
      CASE_NUMBER_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CASE_NUMBER_RE.exec(text)) !== null) {
        this.caseNumbers.add(normalizeCaseNumber(m[0]));
      }
    }
  }

  private extractLawArticlesFromResult(toolName: string, result: any): void {
    // Legislation tools return structured article data
    if (toolName.includes('legislation') || toolName.includes('law') || toolName.includes('relevant')) {
      this.extractArticlesFromStructured(result);
    }

    // MCP content wrapper
    if (result.content && Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          try {
            const parsed = JSON.parse(block.text);
            this.extractArticlesFromStructured(parsed);
          } catch {
            // not JSON
          }
        }
      }
    }
  }

  private extractArticlesFromStructured(obj: any): void {
    if (!obj || typeof obj !== 'object') return;

    // Direct article_number field
    if (obj.article_number) {
      const base = String(obj.article_number).split('.')[0];
      this.lawArticles.add(normalizeArticleRef(base));
    }

    // rada_id field → track which codes were searched
    if (obj.rada_id) {
      this.searchedRadaIds.add(String(obj.rada_id));
    }

    // Results array
    if (Array.isArray(obj.results)) {
      for (const r of obj.results) {
        if (r.article_number) {
          const base = String(r.article_number).split('.')[0];
          this.lawArticles.add(normalizeArticleRef(base));
          if (r.code) {
            this.lawArticles.add(normalizeArticleRef(`${base}:${r.code.toUpperCase()}`));
          }
        }
        if (r.rada_id) this.searchedRadaIds.add(String(r.rada_id));
      }
    }

    // Articles array
    if (Array.isArray(obj.articles)) {
      for (const a of obj.articles) {
        if (a.number || a.article_number) {
          const num = String(a.number || a.article_number).split('.')[0];
          this.lawArticles.add(normalizeArticleRef(num));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: verification against accumulated sets
  // ---------------------------------------------------------------------------

  private findFabricatedCaseNumbers(answerText: string): string[] {
    CASE_NUMBER_RE.lastIndex = 0;
    const seen = new Set<string>();
    const fabricated: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(answerText)) !== null) {
      const raw = m[0];
      const norm = normalizeCaseNumber(raw);
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (!this.caseNumbers.has(norm)) fabricated.push(raw);
    }
    return fabricated;
  }

  private findFabricatedLawArticles(answerText: string): string[] {
    const seen = new Set<string>();
    const fabricated: string[] = [];

    for (const re of [LAW_ARTICLE_RE, SUBPOINT_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(answerText)) !== null) {
        const num = m[1];
        const code = m[2] || '';
        const raw = m[0].trim();
        const baseArticle = num.split('.')[0];

        if (code) {
          const radaId = CODE_TO_RADA[code.toUpperCase()];
          if (radaId && !this.searchedRadaIds.has(radaId)) continue;
        } else {
          continue;
        }

        const norm = normalizeArticleRef(`${baseArticle}${code ? ':' + code.toUpperCase() : ''}`);
        if (seen.has(norm)) continue;
        seen.add(norm);
        if (!this.lawArticles.has(norm) && !this.lawArticles.has(normalizeArticleRef(baseArticle))) {
          fabricated.push(raw);
        }
      }
    }
    return fabricated;
  }
}
