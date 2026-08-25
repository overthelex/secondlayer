/**
 * extractChEvidence unit tests — Swiss (CH) court decision and legislation tools.
 */

import { describe, it, expect } from 'vitest';
import { extractChEvidence } from '../ch';

describe('extractChEvidence', () => {
  describe('ch_search_court_decisions', () => {
    it('maps result rows to Decision[]', () => {
      const data = {
        results: [
          {
            ecli: 'ECLI:CH:BGER:2017:4A.22.2017',
            doc_id: 'doc123',
            court_code: 'BGer',
            court_name: 'Bundesgericht',
            chamber: 'I. zivilrechtliche Abteilung',
            canton: null,
            decision_date: '2017-05-10',
            decision_date_unknown: false,
            docket_number: '4A_22/2017',
            languages: ['de'],
            abstract: 'Some abstract text.',
            snippet: 'Ein Auszug aus dem Urteil.',
            html_url: 'https://example.org/decision.html',
            pdf_url: 'https://example.org/decision.pdf',
            rank: 0.234,
          },
        ],
        total_count: 1,
        has_more: false,
        limit: 20,
        offset: 0,
      };

      const result = extractChEvidence('ch_search_court_decisions', data);

      expect(result.decisions).toHaveLength(1);
      expect(result.citations).toHaveLength(0);
      const d = result.decisions[0];
      expect(d.id).toBe('ECLI:CH:BGER:2017:4A.22.2017');
      expect(d.number).toBe('Bundesgericht · 4A_22/2017');
      expect(d.court).toBe('Bundesgericht');
      expect(d.date).toBe('2017-05-10');
      expect(d.summary).toBe('Ein Auszug aus dem Urteil.');
      expect(d.externalUrl).toBe('https://example.org/decision.html');
      expect(d.docId).toBe('doc123');
      expect(d.status).toBe('active');
      // rank 0.234 scaled to 0..100 and rounded
      expect(d.relevance).toBe(23);
    });

    it('defaults relevance to 100 when rank is absent', () => {
      const data = {
        results: [{
          ecli: 'ECLI:CH:BGER:2020:1C.1.2020',
          court_name: 'Bundesgericht',
          docket_number: '1C_1/2020',
          decision_date: '2020-01-01',
          decision_date_unknown: false,
          abstract: 'No rank here.',
        }],
        total_count: 1, has_more: false, limit: 20, offset: 0,
      };

      const result = extractChEvidence('ch_search_court_decisions', data);
      expect(result.decisions[0].relevance).toBe(100);
    });

    it('shows a Ukrainian "unknown date" marker in the date slot when decision_date_unknown is true', () => {
      const data = {
        results: [{
          ecli: 'ECLI:CH:BGER:2021:2C.2.2021',
          court_name: 'Bundesgericht',
          docket_number: '2C_2/2021',
          decision_date: null,
          decision_date_unknown: true,
          abstract: 'Unknown date case.',
        }],
        total_count: 1, has_more: false, limit: 20, offset: 0,
      };

      const result = extractChEvidence('ch_search_court_decisions', data);
      expect(result.decisions[0].date).toBe('Дата невідома (джерело)');
    });

    it('falls back to pdf_url when html_url is missing, and abstract when snippet is missing', () => {
      const data = {
        results: [
          {
            ecli: 'ECLI:CH:BGER:2018:1B.1.2018',
            doc_id: 'doc456',
            court_code: 'BGer',
            court_name: null,
            docket_number: null,
            decision_date: null,
            decision_date_unknown: true,
            abstract: 'Abstract only.',
            snippet: null,
            html_url: null,
            pdf_url: 'https://example.org/decision.pdf',
          },
        ],
        total_count: 1,
        has_more: false,
        limit: 20,
        offset: 0,
      };

      const result = extractChEvidence('ch_search_court_decisions', data);
      const d = result.decisions[0];
      expect(d.number).toBe('BGer · ECLI:CH:BGER:2018:1B.1.2018');
      expect(d.summary).toBe('Abstract only.');
      expect(d.externalUrl).toBe('https://example.org/decision.pdf');
    });

    it('returns empty evidence for an empty results array', () => {
      const result = extractChEvidence('ch_search_court_decisions', { results: [], total_count: 0, has_more: false, limit: 20, offset: 0 });
      expect(result.decisions).toHaveLength(0);
    });
  });

  describe('ch_get_court_decision', () => {
    it('maps a single decision object to Decision[]', () => {
      const data = {
        ecli: 'ECLI:CH:BGER:2017:4A.22.2017',
        doc_id: 'doc123',
        spider: 'bger',
        court_code: 'BGer',
        court_name: 'Bundesgericht',
        chamber: 'I. zivilrechtliche Abteilung',
        canton: null,
        decision_type: 'Urteil',
        decision_date: '2017-05-10',
        decision_date_unknown: false,
        docket_number: '4A_22/2017',
        languages: ['de'],
        parties: 'A. gegen B.',
        abstract: 'Full abstract of the decision.',
        full_text: 'Volltext des Urteils...',
        full_text_truncated: false,
        full_text_length: 1234,
        text_source: 'html',
        text_quality: 'good',
        html_url: 'https://example.org/decision.html',
        pdf_url: 'https://example.org/decision.pdf',
        json_url: 'https://example.org/decision.json',
      };

      const result = extractChEvidence('ch_get_court_decision', data);
      expect(result.decisions).toHaveLength(1);
      const d = result.decisions[0];
      expect(d.id).toBe('ECLI:CH:BGER:2017:4A.22.2017');
      expect(d.number).toBe('Bundesgericht · 4A_22/2017');
      expect(d.summary).toBe('Full abstract of the decision.');
      expect(d.externalUrl).toBe('https://example.org/decision.html');
      expect(d.docId).toBe('doc123');
    });

    it('falls back to full_text when abstract is absent', () => {
      const data = {
        ecli: 'ECLI:CH:BGER:2019:9C.1.2019',
        doc_id: 'doc789',
        court_code: 'BGer',
        court_name: 'Bundesgericht',
        docket_number: '9C_1/2019',
        decision_date: '2019-01-01',
        abstract: null,
        full_text: 'A'.repeat(600),
        html_url: 'https://example.org/d.html',
      };
      const result = extractChEvidence('ch_get_court_decision', data);
      expect(result.decisions[0].summary.length).toBeLessThanOrEqual(501);
      expect(result.decisions[0].summary.startsWith('A')).toBe(true);
    });

    it('returns empty evidence for a not_found error payload', () => {
      const data = { error: 'not_found', ecli: 'ECLI:X', doc_id: null };
      const result = extractChEvidence('ch_get_court_decision', data);
      expect(result.decisions).toHaveLength(0);
      expect(result.citations).toHaveLength(0);
    });

    it('returns empty evidence for a not_loaded error payload', () => {
      const data = { error: 'not_loaded', ecli: 'ECLI:X', doc_id: null, stage: 'indexed' };
      const result = extractChEvidence('ch_get_court_decision', data);
      expect(result.decisions).toHaveLength(0);
      expect(result.citations).toHaveLength(0);
    });

    it('shows a Ukrainian "unknown date" marker in the date slot when decision_date_unknown is true', () => {
      const data = {
        ecli: 'ECLI:CH:BGER:2019:9C.1.2019',
        doc_id: 'doc789',
        court_code: 'BGer',
        court_name: 'Bundesgericht',
        docket_number: '9C_1/2019',
        decision_date: null,
        decision_date_unknown: true,
        abstract: 'Abstract.',
        html_url: 'https://example.org/d.html',
      };
      const result = extractChEvidence('ch_get_court_decision', data);
      expect(result.decisions[0].date).toBe('Дата невідома (джерело)');
    });
  });

  describe('ch_search_legislation', () => {
    it('maps result rows to Citation[]', () => {
      const data = {
        results: [
          {
            act_id: 1,
            sr_number: '220',
            abbreviation: 'OR',
            title: 'Obligationenrecht',
            title_de: 'Obligationenrecht',
            title_fr: 'Code des obligations',
            title_it: 'Codice delle obbligazioni',
            date_entry_force: '1912-01-01',
            date_no_longer_in_force: null,
            in_force: true,
            editions_count: 12,
            latest_edition_date: '2023-01-01',
            eli_work_uri: 'https://fedlex.admin.ch/eli/cc/27/317_321_377',
          },
        ],
        total_count: 1,
        has_more: false,
        limit: 20,
        offset: 0,
      };

      const result = extractChEvidence('ch_search_legislation', data);
      expect(result.citations).toHaveLength(1);
      const c = result.citations[0];
      expect(c.npaTitle).toContain('Obligationenrecht');
      expect(c.npaTitle).toContain('220');
      expect(c.url).toBe('https://fedlex.admin.ch/eli/cc/27/317_321_377');
      expect(typeof c.text).toBe('string');
      expect(c.text.length).toBeGreaterThan(0);
      // articleNumber carries the abbreviation so RegulationsTab renders the Fedlex link
      // (it only shows citation.url inside the articleNumber badge block).
      expect(c.articleNumber).toBe('OR');
    });

    it('falls back to the sr_number for articleNumber when abbreviation is absent', () => {
      const data = {
        results: [
          {
            act_id: 2,
            sr_number: '210',
            abbreviation: null,
            title: 'Zivilgesetzbuch',
            title_de: 'Zivilgesetzbuch',
            date_entry_force: '1912-01-01',
            date_no_longer_in_force: null,
            in_force: true,
            editions_count: 5,
            latest_edition_date: '2022-01-01',
            eli_work_uri: 'https://fedlex.admin.ch/eli/cc/24/233_245_233',
          },
        ],
        total_count: 1, has_more: false, limit: 20, offset: 0,
      };

      const result = extractChEvidence('ch_search_legislation', data);
      expect(result.citations[0].articleNumber).toBe('210');
    });

    it('never puts a literal "null" in npaTitle when title is absent', () => {
      const data = {
        results: [
          {
            act_id: 3,
            sr_number: '220',
            abbreviation: 'OR',
            title: null,
            date_entry_force: '1912-01-01',
            date_no_longer_in_force: null,
            in_force: true,
            editions_count: 2,
            latest_edition_date: '2020-01-01',
            eli_work_uri: 'https://fedlex.admin.ch/eli/cc/27/317_321_377',
          },
        ],
        total_count: 1, has_more: false, limit: 20, offset: 0,
      };

      const result = extractChEvidence('ch_search_legislation', data);
      expect(result.citations[0].npaTitle).toBe('(SR 220)');
      expect(result.citations[0].npaTitle).not.toContain('null');
    });
  });

  describe('ch_get_act_article', () => {
    it('maps a single article to one Citation', () => {
      const data = {
        sr_number: '220',
        abbreviation: 'OR',
        title: 'Obligationenrecht',
        lang: 'de',
        as_of: '2020-01-01',
        version: {
          version_id: 55,
          date_applicability: '2016-06-01',
          date_end_applicability: '2020-01-01',
          eli_consolidation_uri: 'https://fedlex.admin.ch/eli/cc/27/317_321_377/2016-06-01',
        },
        article: {
          e_id: 'art_336',
          article_number: '336',
          marginal_note: 'B. Kündigungsschutz',
          text: 'Die Kündigung des Arbeitsverhältnisses kann von jeder Vertragspartei angefochten werden.',
        },
        other_editions: 3,
      };

      const result = extractChEvidence('ch_get_act_article', data);
      expect(result.citations).toHaveLength(1);
      const c = result.citations[0];
      expect(c.npaTitle).toBe('Art. 336 OR (SR 220)');
      expect(c.articleNumber).toBe('336');
      expect(c.text).toContain('Kündigung des Arbeitsverhältnisses');
      expect(c.url).toBe('https://fedlex.admin.ch/eli/cc/27/317_321_377/2016-06-01');
    });

    it('returns empty evidence for a no_edition_for_date error payload', () => {
      const data = { error: 'no_edition_for_date', earliest_edition: '2010-01-01' };
      const result = extractChEvidence('ch_get_act_article', data);
      expect(result.citations).toHaveLength(0);
    });

    it('returns empty evidence for an article_not_found error payload', () => {
      const data = { error: 'article_not_found', available_examples: ['1', '2'] };
      const result = extractChEvidence('ch_get_act_article', data);
      expect(result.citations).toHaveLength(0);
    });

    it('never puts a literal "null" in npaTitle when abbreviation is absent', () => {
      const data = {
        sr_number: '220',
        abbreviation: null,
        title: 'Obligationenrecht',
        lang: 'de',
        as_of: '2020-01-01',
        version: {
          version_id: 55,
          date_applicability: '2016-06-01',
          date_end_applicability: '2020-01-01',
          eli_consolidation_uri: 'https://fedlex.admin.ch/eli/cc/27/317_321_377/2016-06-01',
        },
        article: {
          e_id: 'art_336',
          article_number: '336',
          marginal_note: 'B. Kündigungsschutz',
          text: 'Text.',
        },
        other_editions: 3,
      };

      const result = extractChEvidence('ch_get_act_article', data);
      const c = result.citations[0];
      expect(c.npaTitle).toBe('Art. 336 (SR 220)');
      expect(c.npaTitle).not.toContain('null');
    });
  });

  describe('ch_get_act_history', () => {
    it('maps changes to Citation[] with a Ukrainian change-type label in the title', () => {
      const data = {
        sr_number: '220',
        abbreviation: 'OR',
        editions: [],
        changes: [
          { date_applicability: '2020-01-01', change_type: 'modified', article_number: '336', e_id: 'art_336' },
          { date_applicability: '2015-01-01', change_type: 'added', article_number: '336a', e_id: 'art_336a' },
          { date_applicability: '2022-01-01', change_type: 'repealed', article_number: '337', e_id: 'art_337' },
        ],
        provenance: [],
      };

      const result = extractChEvidence('ch_get_act_history', data);
      expect(result.citations).toHaveLength(3);
      expect(result.citations[0].npaTitle).toBe('змінено 2020-01-01');
      expect(result.citations[0].articleNumber).toBe('336');
      expect(result.citations[1].npaTitle).toBe('додано 2015-01-01');
      expect(result.citations[2].npaTitle).toBe('скасовано 2022-01-01');
    });

    it('caps citations at 50 items', () => {
      const changes = Array.from({ length: 80 }, (_, i) => ({
        date_applicability: `2020-01-${String((i % 28) + 1).padStart(2, '0')}`,
        change_type: 'modified',
        article_number: String(i),
        e_id: `art_${i}`,
      }));
      const data = { sr_number: '220', abbreviation: 'OR', editions: [], changes, provenance: [] };

      const result = extractChEvidence('ch_get_act_history', data);
      expect(result.citations).toHaveLength(50);
    });

    it('returns empty evidence for an act_not_found error payload', () => {
      const data = { error: 'act_not_found', sr_number: '999' };
      const result = extractChEvidence('ch_get_act_history', data);
      expect(result.citations).toHaveLength(0);
    });

    it('maps editions to Citation[]', () => {
      const data = {
        sr_number: '220',
        abbreviation: 'OR',
        editions: [
          { date_applicability: '2015-01-01', date_end_applicability: '2020-01-01', article_count: 1 },
          { date_applicability: '2020-01-01', date_end_applicability: null, article_count: 2 },
        ],
        changes: [],
        provenance: [],
      };

      const result = extractChEvidence('ch_get_act_history', data);
      expect(result.citations).toHaveLength(2);
      expect(result.citations[0].npaTitle).toBe('Редакція 2015-01-01 — 2020-01-01');
      expect(result.citations[1].npaTitle).toBe('Редакція 2020-01-01 — донині');
      expect(result.citations[0].source).toBe('OR (SR 220)');
    });

    it('maps provenance to Citation[] with a title from action/effective_date and a body from as_reference/bbl_reference', () => {
      const data = {
        sr_number: '220',
        abbreviation: 'OR',
        editions: [],
        changes: [],
        provenance: [
          {
            e_id: 'art_336_a', action: 'inserted', as_reference: 'AS 2019 1234',
            bbl_reference: 'BBl 2018 1667', effective_date: '2020-01-01',
          },
          { e_id: 'art_337', action: null, as_reference: null, bbl_reference: null, effective_date: null },
        ],
      };

      const result = extractChEvidence('ch_get_act_history', data);
      expect(result.citations).toHaveLength(2);
      expect(result.citations[0].npaTitle).toBe('inserted 2020-01-01');
      expect(result.citations[0].text).toBe('AS 2019 1234; BBl 2018 1667');
      // action/effective_date both absent: falls back to 'зміна' with nothing trailing
      expect(result.citations[1].npaTitle).toBe('зміна');
      expect(result.citations[1].text).toBe('');
    });

    it('caps editions and provenance at 50 items each, independently of changes', () => {
      const editions = Array.from({ length: 60 }, (_, i) => ({
        date_applicability: `20${String(i % 100).padStart(2, '0')}-01-01`, date_end_applicability: null,
      }));
      const provenance = Array.from({ length: 60 }, (_, i) => ({
        e_id: `art_${i}`, action: 'modified', as_reference: `AS ${i}`, bbl_reference: null, effective_date: '2020-01-01',
      }));
      const data = { sr_number: '220', abbreviation: 'OR', editions, changes: [], provenance };

      const result = extractChEvidence('ch_get_act_history', data);
      expect(result.citations).toHaveLength(100);
    });

    it('yields evidence from editions and provenance when changes is empty', () => {
      const data = {
        sr_number: '220',
        abbreviation: 'OR',
        editions: [{ date_applicability: '2020-01-01', date_end_applicability: null }],
        changes: [],
        provenance: [{ e_id: 'art_1', action: 'modified', as_reference: 'AS 1', bbl_reference: null, effective_date: '2020-01-01' }],
      };

      const result = extractChEvidence('ch_get_act_history', data);
      expect(result.citations).toHaveLength(2);
    });
  });

  describe('unrelated tools', () => {
    it('returns empty evidence for a non-CH tool name', () => {
      const result = extractChEvidence('search_court_decisions', { results: [{ ecli: 'x' }] });
      expect(result.decisions).toHaveLength(0);
      expect(result.citations).toHaveLength(0);
      expect(result.documents).toHaveLength(0);
    });
  });
});
