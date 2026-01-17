import { Database } from '../database/database.js';
import { PrecedentStatus, PrecedentStatusType, CitationLink } from '../types/index.js';

export class CitationValidator {
  constructor(private db: Database) {}

  async extractCitations(text: string, caseId: string): Promise<CitationLink[]> {
    const citations: CitationLink[] = [];

    // Regex patterns for case numbers (Ukrainian format)
    const caseNumberPatterns = [
      /\d+\/\d+\/\d{4}/g, // Format: 123/456/2024
      /справа\s+№\s*\d+/gi,
      /рішення\s+№\s*\d+/gi,
    ];

    for (const pattern of caseNumberPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const caseNumber = match[0];
        
        // Try to find the case in database
        const citedCase = await this.findCaseByNumber(caseNumber);
        if (citedCase) {
          const citationType = this.determineCitationType(text, match.index || 0);
          
          citations.push({
            from_case_id: caseId,
            to_case_id: citedCase.id,
            citation_type: citationType,
            context: this.extractContext(text, match.index || 0),
            confidence: 0.7,
          });
        }
      }
    }

    return citations;
  }

  async validatePrecedentStatus(caseId: string): Promise<PrecedentStatus> {
    // Check if status already exists
    const existing = await this.db.query(
      'SELECT * FROM precedent_status WHERE case_id = $1',
      [caseId]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return {
        case_id: caseId,
        status: row.status as PrecedentStatusType,
        reversed_by: row.reversed_by || [],
        overruled_by: row.overruled_by || [],
        distinguished_in: row.distinguished_in || [],
        last_checked: row.last_checked.toISOString(),
        confidence: row.confidence,
      };
    }

    // Analyze citations to determine status
    const citations = await this.db.query(
      `SELECT * FROM citation_links WHERE to_case_id = $1`,
      [caseId]
    );

    const status = this.analyzeStatus(citations.rows);
    
    // Save status
    await this.db.query(
      `INSERT INTO precedent_status 
       (case_id, status, reversed_by, overruled_by, distinguished_in, confidence, last_checked)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (case_id) DO UPDATE SET
         status = EXCLUDED.status,
         reversed_by = EXCLUDED.reversed_by,
         overruled_by = EXCLUDED.overruled_by,
         distinguished_in = EXCLUDED.distinguished_in,
         confidence = EXCLUDED.confidence,
         last_checked = EXCLUDED.last_checked`,
      [
        caseId,
        status.status,
        status.reversed_by || [],
        status.overruled_by || [],
        status.distinguished_in || [],
        status.confidence,
      ]
    );

    return {
      case_id: caseId,
      ...status,
      last_checked: new Date().toISOString(),
    };
  }

  async buildCitationGraph(caseId: string, depth: number = 2): Promise<any> {
    const graph: any = {
      nodes: [],
      edges: [],
    };

    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: caseId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id) || current.depth > depth) continue;
      visited.add(current.id);

      // Get case info
      const caseInfo = await this.db.query(
        'SELECT id, title, date FROM documents WHERE id = $1',
        [current.id]
      );

      if (caseInfo.rows.length > 0) {
        graph.nodes.push({
          id: current.id,
          title: caseInfo.rows[0].title,
          date: caseInfo.rows[0].date,
        });
      }

      // Get citations
      const citations = await this.db.query(
        `SELECT * FROM citation_links 
         WHERE from_case_id = $1 OR to_case_id = $1`,
        [current.id]
      );

      for (const citation of citations.rows) {
        const targetId = citation.from_case_id === current.id 
          ? citation.to_case_id 
          : citation.from_case_id;

        if (!visited.has(targetId) && current.depth < depth) {
          queue.push({ id: targetId, depth: current.depth + 1 });
        }

        graph.edges.push({
          from: citation.from_case_id,
          to: citation.to_case_id,
          type: citation.citation_type,
          confidence: citation.confidence,
        });
      }
    }

    return graph;
  }

  async saveCitations(citations: CitationLink[]): Promise<void> {
    for (const citation of citations) {
      await this.db.query(
        `INSERT INTO citation_links 
         (from_case_id, to_case_id, citation_type, context, section_type, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (from_case_id, to_case_id, citation_type) DO UPDATE SET
           context = EXCLUDED.context,
           confidence = EXCLUDED.confidence`,
        [
          citation.from_case_id,
          citation.to_case_id,
          citation.citation_type,
          citation.context,
          citation.section_type,
          citation.confidence,
        ]
      );
    }
  }

  private async findCaseByNumber(caseNumber: string): Promise<any | null> {
    const result = await this.db.query(
      `SELECT id FROM documents 
       WHERE zakononline_id LIKE $1 OR metadata->>'case_number' = $2
       LIMIT 1`,
      [`%${caseNumber}%`, caseNumber]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  }

  private determineCitationType(text: string, position: number): 'follows' | 'distinguishes' | 'overrules' | 'references' {
    const context = this.extractContext(text, position).toLowerCase();

    if (context.includes('не погоджується') || context.includes('відступає')) {
      return 'distinguishes';
    }
    if (context.includes('скасовано') || context.includes('відмінено')) {
      return 'overrules';
    }
    if (context.includes('посилається') || context.includes('з посиланням')) {
      return 'references';
    }

    return 'follows';
  }

  private extractContext(text: string, position: number, length: number = 200): string {
    const start = Math.max(0, position - length / 2);
    const end = Math.min(text.length, position + length / 2);
    return text.substring(start, end);
  }

  private analyzeStatus(citations: any[]): {
    status: PrecedentStatusType;
    reversed_by?: string[];
    overruled_by?: string[];
    distinguished_in?: string[];
    confidence: number;
  } {
    if (citations.length === 0) {
      return { status: 'unknown', confidence: 0.5 };
    }

    const overruledBy: string[] = [];
    const distinguishedIn: string[] = [];

    for (const citation of citations) {
      if (citation.citation_type === 'overrules') {
        overruledBy.push(citation.from_case_id);
      } else if (citation.citation_type === 'distinguishes') {
        distinguishedIn.push(citation.from_case_id);
      }
    }

    let status: PrecedentStatusType = 'valid';
    let confidence = 0.8;

    if (overruledBy.length > 0) {
      status = 'explicitly_overruled';
      confidence = 0.9;
    } else if (distinguishedIn.length > 0) {
      status = 'questioned';
      confidence = 0.7;
    }

    return {
      status,
      overruled_by: overruledBy.length > 0 ? overruledBy : undefined,
      distinguished_in: distinguishedIn.length > 0 ? distinguishedIn : undefined,
      confidence,
    };
  }
}
