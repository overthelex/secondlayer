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

  describe('ch_search_companies', () => {
    const ZEFIX_ROW = {
      uid: 'CHE-123.456.789',
      name: 'Muster Handels AG',
      legal_form: 'Aktiengesellschaft',
      legal_seat: 'Zürich',
      canton: 'ZH',
      status: 'active',
      purpose: 'Handel mit Waren aller Art.',
      shab_count: 3,
      last_shab_date: '2025-02-02',
      bankruptcy: false,
      source: 'zefix',
    };

    it('maps a Zefix row to a registry document', () => {
      const result = extractChEvidence('ch_search_companies', {
        results: [ZEFIX_ROW], total_count: 1, has_more: false, limit: 20, offset: 0,
      });

      expect(result.decisions).toHaveLength(0);
      expect(result.citations).toHaveLength(0);
      expect(result.documents).toHaveLength(1);

      const doc = result.documents[0];
      expect(doc.id).toBe('ch-company-CHE-123.456.789');
      expect(doc.title).toBe('Muster Handels AG (CHE-123.456.789)');
      expect(doc.type).toBe('other');
      expect(doc.metadata?.subtitle).toBe('Aktiengesellschaft · Zürich · ZH · у реєстрі');
      expect(doc.metadata?.body).toBe('Handel mit Waren aller Art.');
      expect(doc.metadata?.snippet).toContain('Публікацій SHAB: 3');
      expect(doc.metadata?.snippet).toContain('остання: 2025-02-02');
      expect(doc.metadata?.uid).toBe('CHE-123.456.789');
      expect(doc.metadata?.bankruptcy).toBe(false);
    });

    it('notes SHAB KK publications in the details, never as a verdict in the title', () => {
      // Rubric KK is the debt-collection and bankruptcy rubric as a whole: KK07 is a
      // REVOCATION of bankruptcy, KK09 a closure. "has KK publications" is a fact; "is
      // bankrupt" is a conclusion the panel is not entitled to draw for the reader.
      const result = extractChEvidence('ch_search_companies', {
        results: [{ ...ZEFIX_ROW, bankruptcy: true }],
      });

      const doc = result.documents[0];
      expect(doc.title).toBe('Muster Handels AG (CHE-123.456.789)');
      expect(doc.title).not.toContain('БАНКРУТСТВО');
      expect(doc.metadata?.snippet).toContain('SHAB KK');
      expect(doc.metadata?.bankruptcy).toBe(true);
    });

    it('labels an inactive company in Ukrainian', () => {
      const result = extractChEvidence('ch_search_companies', {
        results: [{ ...ZEFIX_ROW, status: 'inactive' }],
      });
      expect(result.documents[0].metadata?.subtitle).toContain('вилучена з реєстру');
    });

    it('keeps a SHAB-only company without a UID and says where it came from', () => {
      const result = extractChEvidence('ch_search_companies', {
        results: [{
          uid: null,
          name: 'Verschwundene Treuhand AG',
          legal_form: 'Aktiengesellschaft',
          legal_seat: 'Bern',
          canton: 'BE',
          status: null,
          purpose: null,
          shab_count: 2,
          last_shab_date: '2020-07-07',
          bankruptcy: false,
          source: 'shab',
        }],
      });

      const doc = result.documents[0];
      expect(doc.title).toBe('Verschwundene Treuhand AG');
      expect(doc.id).toBe('ch-company-Verschwundene Treuhand AG');
      expect(doc.metadata?.subtitle).toContain('лише SHAB (немає в Zefix)');
      expect(doc.metadata?.uid).toBeUndefined();
    });

    it('returns no documents for an empty result set', () => {
      const result = extractChEvidence('ch_search_companies', { results: [], total_count: 0 });
      expect(result.documents).toHaveLength(0);
    });
  });

  describe('ch_get_company', () => {
    const CARD = {
      company: {
        uid: 'CHE-123.456.789',
        name: 'Muster Handels AG',
        legal_form: 'Aktiengesellschaft',
        legal_seat: 'Zürich',
        canton: 'ZH',
        status: 'active',
        purpose: 'Handel mit Waren aller Art.',
      },
      shab: [
        { shab_id: 'SHAB-KK01', publication_date: '2025-02-02', rubric: 'KK', content: 'Konkurs.' },
        { shab_id: 'SHAB-HR01', publication_date: '2024-01-15', rubric: 'HR', content: 'Eintragung.' },
      ],
      bankruptcies: [{ shab_id: 'SHAB-KK01', publication_date: '2025-02-02', rubric: 'KK' }],
      finma: [{ entity_name: 'Muster Handels AG', authorization_number: 'FINMA-001' }],
      seco: [{ ssid: '900001', primary_name: 'Muster Handels AG', programme: 'Ukraine' }],
      kantonsblatt: [{ publication_number: 'KB-1', title: 'Muster Handels AG' }],
      normalized_name: 'muster handels',
      name_match_note: 'FINMA та SECO не публікують UID; кантональні відомості зіставлені точно за UID.',
    };

    it('builds one company card document with the register hit counts', () => {
      const result = extractChEvidence('ch_get_company', CARD);

      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc.title).toBe('Muster Handels AG (CHE-123.456.789)');
      expect(doc.metadata?.subtitle).toBe('Aktiengesellschaft · Zürich · ZH · у реєстрі');
      expect(doc.metadata?.body).toBe('Handel mit Waren aller Art.');
      expect(doc.metadata?.finma_count).toBe(1);
      expect(doc.metadata?.seco_count).toBe(1);
      expect(doc.metadata?.kantonsblatt_count).toBe(1);
      expect(doc.metadata?.bankruptcy_count).toBe(1);
      expect(doc.metadata?.register_hits).toContain('SECO (санкції): 1');
      // Counted and named by rubric, not asserted as an outcome.
      expect(doc.metadata?.register_hits).toContain('SHAB KK');
      expect(doc.metadata?.register_hits).not.toContain('БАНКРУТСТВО');
      expect(doc.metadata?.snippet).toContain('FINMA: 1');
      expect(doc.metadata?.snippet).toContain('Публікацій SHAB: 2');
      // The heuristic-match caveat must survive into the panel, not be dropped.
      expect(doc.metadata?.name_match_note).toBe(CARD.name_match_note);
      // Nothing was capped here, so the counts are stated plainly.
      expect(doc.metadata?.snippet).not.toContain('показано');
    });

    it('labels a capped section as a page, not as the company total', () => {
      // ch_get_company returns at most 100 SHAB publications and 50 rows per register.
      // A count that is really "the first 50 of however many" was being rendered as the
      // company's total, so a card said "FINMA: 50" for a bank with 300 authorisations.
      const result = extractChEvidence('ch_get_company', {
        ...CARD,
        shab_truncated: true,
        bankruptcies_truncated: true,
        finma_truncated: true,
        seco_truncated: true,
        kantonsblatt_truncated: true,
      });

      const doc = result.documents[0];
      expect(doc.metadata?.snippet).toContain('Публікацій SHAB: показано 2');
      expect(doc.metadata?.register_hits).toContain('FINMA: показано 1');
      expect(doc.metadata?.register_hits).toContain('SECO (санкції): показано 1');
      expect(doc.metadata?.register_hits).toContain('Кантональні відомості: показано 1');
      expect(doc.metadata?.register_hits).toContain('SHAB KK (стягнення/банкрутство): показано 1');
    });

    it('falls back to the newest SHAB publication when Zefix records no purpose', () => {
      const result = extractChEvidence('ch_get_company', {
        ...CARD,
        company: { ...CARD.company, purpose: null },
      });
      expect(result.documents[0].metadata?.body).toBe('Konkurs.');
    });

    it('omits the register-hit line when no other register lists the company', () => {
      const result = extractChEvidence('ch_get_company', {
        company: CARD.company,
        shab: [], bankruptcies: [], finma: [], seco: [], kantonsblatt: [],
      });

      const doc = result.documents[0];
      expect(doc.title).toBe('Muster Handels AG (CHE-123.456.789)');
      expect(doc.metadata?.register_hits).toBeUndefined();
      expect(doc.metadata?.snippet).not.toContain('FINMA');
    });

    it('produces no document for a not_found payload', () => {
      const result = extractChEvidence('ch_get_company', { error: 'not_found', uid: 'CHE-555.555.555' });
      expect(result.documents).toHaveLength(0);
    });
  });

  describe('cantonal acts (jurisdiction != CH)', () => {
    it('labels a cantonal search result with the canton code instead of SR', () => {
      const data = {
        results: [
          {
            act_id: 7,
            sr_number: '131.1',
            abbreviation: 'KV',
            title: 'Verfassung des Kantons Zürich',
            in_force: true,
            jurisdiction: 'ZH',
          },
        ],
        total_count: 1,
        has_more: false,
        limit: 20,
        offset: 0,
      };

      const result = extractChEvidence('ch_search_legislation', data);
      expect(result.citations[0].npaTitle).toBe('Verfassung des Kantons Zürich (ZH 131.1)');
    });

    it('keeps the SR label for an explicit federal jurisdiction', () => {
      const data = {
        results: [{ act_id: 1, sr_number: '220', title: 'Obligationenrecht', in_force: true, jurisdiction: 'CH' }],
        total_count: 1,
        has_more: false,
        limit: 20,
        offset: 0,
      };

      const result = extractChEvidence('ch_search_legislation', data);
      expect(result.citations[0].npaTitle).toBe('Obligationenrecht (SR 220)');
    });

    it('labels a cantonal article and history with the canton code', () => {
      const article = extractChEvidence('ch_get_act_article', {
        sr_number: '131.1',
        jurisdiction: 'ZH',
        abbreviation: 'KV',
        version: { version_id: 1, date_applicability: '2020-01-01', date_end_applicability: null },
        article: { e_id: 'art_1', article_number: '1', text: 'Text' },
      });
      expect(article.citations[0].npaTitle).toBe('Art. 1 KV (ZH 131.1)');

      const history = extractChEvidence('ch_get_act_history', {
        sr_number: '131.1',
        jurisdiction: 'BE',
        editions: [{ date_applicability: '2020-01-01', date_end_applicability: null, article_count: 1 }],
        changes: [],
        provenance: [],
      });
      expect(history.citations[0].source).toBe('BE 131.1');
    });
  });

  describe('ch_get_decision_legislation', () => {
    const DECISION = {
      ecli: 'ECLI:CH:BGER:2020:4A.1.2020',
      decision_date: '2020-03-15',
      effective_date: '2020-03-15',
      date_unreliable: false,
      lang: 'de',
      total_cited_acts: 3,
      acts_truncated: false,
      unresolved: { count: 0, top_abbrs: [] },
      acts: [
        {
          act_id: 1,
          sr_number: '220',
          title: 'Obligationenrecht',
          abbreviation: 'OR',
          jurisdiction: 'CH',
          citations_count: 5,
          articles_cited: ['1', '18', '336'],
          articles_truncated: false,
          edition: { date_applicability: '2016-06-01', date_end_applicability: '2020-01-01', source: 'fedlex', lang: 'de' },
          retrieval_status: 'edition_at_date',
          next: { tool: 'ch_get_act_text', act_id: 1, as_of: '2020-03-15', lang: 'de' },
        },
      ],
    };

    it('maps each cited act to one Citation with the edition-at-date status', () => {
      const result = extractChEvidence('ch_get_decision_legislation', DECISION);
      expect(result.citations).toHaveLength(1);
      const c = result.citations[0];
      expect(c.npaTitle).toBe('Obligationenrecht (SR 220)');
      expect(c.articleNumber).toBe('OR');
      expect(c.text).toContain('2020-03-15');
      expect(c.text).toContain('5');
      expect(c.sectionTitle).toBe('2016-06-01 — 2020-01-01');
    });

    it('labels a cantonal act with the canton code, mirroring the search/article citations', () => {
      const data = {
        ...DECISION,
        acts: [{ ...DECISION.acts[0], sr_number: '131.1', jurisdiction: 'ZH', title: 'KV', abbreviation: null }],
      };
      const result = extractChEvidence('ch_get_decision_legislation', data);
      expect(result.citations[0].npaTitle).toBe('KV (ZH 131.1)');
      expect(result.citations[0].articleNumber).toBe('131.1');
    });

    it('flags a nearest-earlier edition with the amended warning wording', () => {
      const data = {
        ...DECISION,
        acts: [{
          ...DECISION.acts[0],
          retrieval_status: 'nearest_earlier_edition',
          edition: { date_applicability: '2010-01-01', date_end_applicability: '2015-12-31', source: 'fedlex', lang: 'de' },
        }],
      };
      const result = extractChEvidence('ch_get_decision_legislation', data);
      expect(result.citations[0].text).toContain('⚠ найближча раніша редакція');
    });

    it('flags a nearest-later edition with the amended warning wording', () => {
      const data = {
        ...DECISION,
        acts: [{
          ...DECISION.acts[0],
          retrieval_status: 'nearest_later_edition',
          edition: { date_applicability: '2021-01-01', date_end_applicability: null, source: 'fedlex', lang: 'de' },
        }],
      };
      const result = extractChEvidence('ch_get_decision_legislation', data);
      expect(result.citations[0].text).toContain('⚠ найближча пізніша редакція');
    });

    it('labels a no_text act as text unavailable and omits the edition interval', () => {
      const data = {
        ...DECISION,
        acts: [{ ...DECISION.acts[0], retrieval_status: 'no_text', edition: null }],
      };
      const result = extractChEvidence('ch_get_decision_legislation', data);
      const c = result.citations[0];
      expect(c.text).toContain('текст недоступний');
      expect(c.sectionTitle).toBeUndefined();
    });

    it('orders citations by citations_count as the backend already sorted them', () => {
      const data = {
        ...DECISION,
        acts: [
          { ...DECISION.acts[0], act_id: 1, citations_count: 5 },
          { ...DECISION.acts[0], act_id: 2, citations_count: 2, sr_number: '210', title: 'ZGB', abbreviation: 'ZGB' },
        ],
      };
      const result = extractChEvidence('ch_get_decision_legislation', data);
      expect(result.citations).toHaveLength(2);
      expect(result.citations[0].text).toContain('5');
      expect(result.citations[1].text).toContain('2');
    });

    it('returns empty evidence for a not_found error payload', () => {
      const result = extractChEvidence('ch_get_decision_legislation', { error: 'not_found', ecli: 'ECLI:X' });
      expect(result.citations).toHaveLength(0);
    });

    // Completeness footer: a synthetic, non-act summary Citation appended at the end so the
    // evidence panel never looks like the full citation list when it isn't. Never fires when
    // both acts_truncated is false and unresolved.count is 0 — the DECISION fixture default.
    describe('completeness footer', () => {
      it('appends nothing when neither acts_truncated nor unresolved.count apply', () => {
        const result = extractChEvidence('ch_get_decision_legislation', DECISION);
        expect(result.citations).toHaveLength(1);
        expect(result.citations.some((c) => c.npaTitle === 'Повнота видачі')).toBe(false);
      });

      it('appends a "Показано N з M актів" footer when acts_truncated is true (truncated-only)', () => {
        const data = { ...DECISION, acts_truncated: true, total_cited_acts: 5 };
        const result = extractChEvidence('ch_get_decision_legislation', data);
        expect(result.citations).toHaveLength(2);
        const footer = result.citations[1];
        expect(footer.npaTitle).toBe('Повнота видачі');
        expect(footer.source).toBe('Повнота видачі');
        expect(footer.articleNumber).toBeUndefined();
        expect(footer.text).toContain('Показано 1 з 5 актів.');
        expect(footer.text).not.toContain('Нерозпізнаних');
      });

      it('appends a "Нерозпізнаних цитувань" footer when unresolved.count > 0 (unresolved-only)', () => {
        const data = {
          ...DECISION,
          unresolved: {
            count: 4,
            top_abbrs: [{ abbr: 'ZPO/ZH', count: 2 }, { abbr: 'GVG', count: 1 }, { abbr: 'EG ZGB', count: 1 }],
          },
        };
        const result = extractChEvidence('ch_get_decision_legislation', data);
        expect(result.citations).toHaveLength(2);
        const footer = result.citations[1];
        expect(footer.text).toContain('Нерозпізнаних цитувань: 4');
        expect(footer.text).toContain('ZPO/ZH, GVG, EG ZGB');
        expect(footer.text).not.toContain('Показано');
      });

      it('combines both sentences when both truncated and unresolved apply', () => {
        const data = {
          ...DECISION,
          acts_truncated: true,
          total_cited_acts: 5,
          unresolved: { count: 4, top_abbrs: [{ abbr: 'ZPO/ZH', count: 2 }] },
        };
        const result = extractChEvidence('ch_get_decision_legislation', data);
        const footer = result.citations[result.citations.length - 1];
        expect(footer.text).toContain('Показано 1 з 5 актів.');
        expect(footer.text).toContain('Нерозпізнаних цитувань: 4');
      });

      it('caps the example abbreviation list at 3', () => {
        const data = {
          ...DECISION,
          unresolved: {
            count: 9,
            top_abbrs: [
              { abbr: 'A', count: 4 }, { abbr: 'B', count: 3 }, { abbr: 'C', count: 1 }, { abbr: 'D', count: 1 },
            ],
          },
        };
        const result = extractChEvidence('ch_get_decision_legislation', data);
        const footer = result.citations[result.citations.length - 1];
        expect(footer.text).toContain('A, B, C');
        expect(footer.text).not.toContain('D');
      });

      it('does not throw and still reports the truncation when unresolved is entirely absent', () => {
        const data = { ...DECISION, acts_truncated: true, total_cited_acts: 5, unresolved: undefined };
        expect(() => extractChEvidence('ch_get_decision_legislation', data)).not.toThrow();
        const result = extractChEvidence('ch_get_decision_legislation', data);
        const footer = result.citations[result.citations.length - 1];
        expect(footer.text).toContain('Показано 1 з 5 актів.');
      });

      it('does not throw and still reports the count when unresolved.top_abbrs is absent', () => {
        const data = { ...DECISION, unresolved: { count: 2 } };
        expect(() => extractChEvidence('ch_get_decision_legislation', data)).not.toThrow();
        const result = extractChEvidence('ch_get_decision_legislation', data);
        const footer = result.citations[result.citations.length - 1];
        expect(footer.text).toContain('Нерозпізнаних цитувань: 2');
      });
    });
  });

  describe('ch_get_act_text', () => {
    const ACT_TEXT = {
      act_id: 1,
      sr_number: '220',
      title: 'Obligationenrecht',
      jurisdiction: 'CH',
      lang: 'de',
      requested_lang: 'de',
      as_of: '2020-03-15',
      retrieval_status: 'edition_at_date',
      edition: { date_applicability: '2016-06-01', date_end_applicability: '2020-01-01', source: 'fedlex' },
      text: 'Art. 1 Der Vertrag...',
      text_offset: 0,
      text_total_chars: 21,
      truncated: false,
    };

    it('builds one VaultDocument with the edition range in the title and the text in the body', () => {
      const result = extractChEvidence('ch_get_act_text', ACT_TEXT);
      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc.title).toContain('Obligationenrecht');
      expect(doc.title).toContain('SR 220');
      expect(doc.title).toContain('2016-06-01');
      expect(doc.title).toContain('2020-01-01');
      expect(doc.metadata?.body).toBe('Art. 1 Der Vertrag...');
      expect(doc.metadata?.truncated).toBe(false);
    });

    it('adds a "показано N з M символів" note when truncated is true', () => {
      const data = { ...ACT_TEXT, text: 'Art. 1 Der Vert', text_total_chars: 21, truncated: true };
      const result = extractChEvidence('ch_get_act_text', data);
      const doc = result.documents[0];
      expect(doc.metadata?.snippet).toContain('показано 15 з 21 символів');
    });

    it('omits the truncation note when truncated is false', () => {
      const result = extractChEvidence('ch_get_act_text', ACT_TEXT);
      expect(result.documents[0].metadata?.snippet).not.toContain('показано');
    });

    it('uses "донині" for an open-ended edition', () => {
      const data = { ...ACT_TEXT, edition: { date_applicability: '2020-01-01', date_end_applicability: null, source: 'fedlex' } };
      const result = extractChEvidence('ch_get_act_text', data);
      expect(result.documents[0].title).toContain('донині');
    });

    it('returns no document for an error payload', () => {
      const result = extractChEvidence('ch_get_act_text', { error: 'no_edition_for_date', act_id: 1, earliest_edition: null });
      expect(result.documents).toHaveLength(0);
    });
  });

  describe('unrelated tools', () => {
    it('returns empty evidence for a non-CH tool name', () => {
      const result = extractChEvidence('search_court_decisions', { results: [{ ecli: 'x' }] });
      expect(result.decisions).toHaveLength(0);
      expect(result.citations).toHaveLength(0);
      expect(result.documents).toHaveLength(0);
    });

    it('does not build decision-legislation citations under an unrelated tool name', () => {
      const result = extractChEvidence('search_legislation', {
        acts: [{ act_id: 1, sr_number: '220', title: 'x', citations_count: 1, retrieval_status: 'edition_at_date' }],
      });
      expect(result.citations).toHaveLength(0);
    });

    it('does not build an act-text document under an unrelated tool name', () => {
      const result = extractChEvidence('get_document', {
        act_id: 1, sr_number: '220', title: 'x', text: 'text', retrieval_status: 'edition_at_date',
      });
      expect(result.documents).toHaveLength(0);
    });
  });

  describe('ch_get_citation_graph', () => {
    const graph = {
      ecli: 'ECLI:CH:BGER:2024:8C.1.2024',
      court_code: 'CH_BGer_008',
      docket_number: '8C_1/2024',
      decision_date: '2024-05-01',
      outbound: {
        cases: [
          {
            to_raw: 'BGE 125 V 351',
            cite_kind: 'bge',
            to_ecli: 'ECLI:CH:CH_BGE:CH_BGE_007_BGE-125-V-351_1999',
            resolved: true,
            court_code: 'CH_BGE_007',
            docket_number: 'BGE 125 V 351',
            decision_date: '1999-10-01',
          },
          { to_raw: '5A_999/2001', cite_kind: 'docket', to_ecli: null, resolved: false },
        ],
        total: 2,
        resolved_count: 1,
        unresolved_count: 1,
        unresolved_refs: ['5A_999/2001'],
      },
      legislation: { total_citations: 4, total_acts: 2, unresolved_count: 1, top_acts: [], next: {} },
      inbound: {
        cited_by_count: 1,
        citing_courts: 1,
        first_citing_date: '2025-01-01',
        last_citing_date: '2025-01-01',
        recent: [
          { from_ecli: 'ECLI:CH:BGER:2025:9C.9.2025', from_date: '2025-01-01', from_court: 'CH_BGer_009' },
        ],
      },
    };

    it('maps resolved outbound targets and inbound citers to Decision[], skipping unresolved', () => {
      const result = extractChEvidence('ch_get_citation_graph', graph);

      const ids = result.decisions.map((d) => d.id);
      expect(ids).toContain('ECLI:CH:CH_BGE:CH_BGE_007_BGE-125-V-351_1999');
      expect(ids).toContain('ECLI:CH:BGER:2025:9C.9.2025');
      // The unresolved reference has no target decision to render.
      expect(ids).not.toContain('5A_999/2001');
      expect(result.citations).toHaveLength(0);
    });

    it('renders nothing for an error payload', () => {
      const result = extractChEvidence('ch_get_citation_graph',
        { error: 'not_found', ecli: 'ECLI:CH:NO:SUCH' });
      expect(result.decisions).toHaveLength(0);
    });
  });

  describe('ch_check_precedent_status', () => {
    it('maps the target decision with a status summary plus its recent citers', () => {
      const result = extractChEvidence('ch_check_precedent_status', {
        ecli: 'ECLI:CH:CH_BGE:CH_BGE_007_BGE-125-V-351_1999',
        docket_number: 'BGE 125 V 351',
        court_code: 'CH_BGE_007',
        decision_date: '1999-10-01',
        variants: ['ECLI:CH:CH_BGE:CH_BGE_007_BGE-125-V-351_1999'],
        status: 'actively_cited',
        cited_by_count: 48441,
        citing_courts: 120,
        first_citing_date: '1999-12-01',
        last_citing_date: '2026-08-01',
        citations_last_5_years: 5000,
        recent_citings: [
          { from_ecli: 'ECLI:CH:BGER:2026:8C.5.2026', from_date: '2026-08-01', from_court: 'CH_BGer_008' },
        ],
      });

      expect(result.decisions[0].id).toBe('ECLI:CH:CH_BGE:CH_BGE_007_BGE-125-V-351_1999');
      expect(result.decisions[0].summary).toContain('48441');
      expect(result.decisions[0].summary).toMatch(/активно цитується/);
      expect(result.decisions.map((d) => d.id)).toContain('ECLI:CH:BGER:2026:8C.5.2026');
    });

    it('renders nothing when the reference is not in the corpus', () => {
      const result = extractChEvidence('ch_check_precedent_status',
        { status: 'not_in_corpus', reference: 'BGE 1 I 1' });
      expect(result.decisions).toHaveLength(0);
    });
  });

  describe('ch_get_commentary', () => {
    const COMMENTARY = {
      id: 7,
      source: 'onlinekommentar',
      source_id: 'abc-123',
      lang: 'de',
      kind: 'article',
      sr_number: '952.0',
      act_title: 'Banking Act',
      abbr: 'BankG',
      article_number: '1b',
      title: 'Art. 1b BankG',
      authors: ['Tamara Teves', 'David Meirich'],
      editors: ['Nina Reiser'],
      version_date: '2026-08-23',
      suggested_citation: 'OK-Teves/Meirich, Art. 1b BankG N. XXX.',
      licence: 'CC-BY-4.0',
      source_url: 'https://onlinekommentar.ch/de/kommentare/bankg1b',
      pdf_url: 'https://onlinekommentar.ch/de/kommentare/bankg1b/print',
      legal_text: 'Art. 1b Innovationsförderung ...',
      text: 'I. Einleitung\n1 Der vorliegende Art. 1b ...',
      text_offset: 0,
      text_total_chars: 43,
      truncated: false,
      attribution: 'OK-Teves/Meirich, Art. 1b BankG N. XXX. — https://onlinekommentar.ch/de/kommentare/bankg1b (CC-BY-4.0)',
    };

    it('builds one VaultDocument with authors, source and licence in the title and the text in the body', () => {
      const result = extractChEvidence('ch_get_commentary', COMMENTARY);
      expect(result.decisions).toHaveLength(0);
      expect(result.citations).toHaveLength(0);
      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc.id).toBe('ch-commentary-onlinekommentar-abc-123');
      expect(doc.title).toContain('Art. 1b BankG');
      expect(doc.title).toContain('Tamara Teves, David Meirich');
      expect(doc.title).toContain('onlinekommentar');
      expect(doc.title).toContain('CC-BY-4.0');
      expect(doc.metadata?.body).toBe(COMMENTARY.text);
      expect(doc.metadata?.snippet).toContain('OK-Teves/Meirich');
      expect(doc.metadata?.snippet).not.toContain('показано');
      expect(doc.metadata?.source_url).toBe(COMMENTARY.source_url);
      expect(doc.metadata?.licence).toBe('CC-BY-4.0');
      expect(doc.metadata?.truncated).toBe(false);
    });

    it('adds the truncation note when the slice is partial', () => {
      const data = { ...COMMENTARY, text: 'I. Einl', text_total_chars: 43, truncated: true };
      const doc = extractChEvidence('ch_get_commentary', data).documents[0];
      expect(doc.metadata?.snippet).toContain('показано 7 з 43 символів');
      expect(doc.metadata?.truncated).toBe(true);
    });

    it('returns no document for a not_found payload', () => {
      const result = extractChEvidence('ch_get_commentary', {
        error: 'not_found', sr_number: '952.0', article: '7', lang: 'de', available_langs: [], available_articles: ['1b'],
      });
      expect(result.documents).toHaveLength(0);
    });
  });

  describe('ch_search_commentary', () => {
    it('maps hits to Citation[] with the source and licence as the source, and the site URL', () => {
      const data = {
        results: [
          {
            id: 7, source: 'onlinekommentar', source_id: 'abc-123', lang: 'de', kind: 'article',
            sr_number: '952.0', act_title: 'Banking Act', abbr: 'BankG', article_number: '1b',
            title: 'Art. 1b BankG', authors: ['Tamara Teves'], editors: [], version_date: '2026-08-23',
            suggested_citation: null, licence: 'CC-BY-4.0',
            source_url: 'https://onlinekommentar.ch/de/kommentare/bankg1b', pdf_url: null,
            rank: 0.1, snippet: 'Die <b>Fintech-Lizenz</b> nach Art. 1b',
          },
          {
            id: 8, source: 'onlinekommentar', source_id: 'def-456', lang: 'de', kind: 'preliminary',
            sr_number: null, act_title: null, abbr: 'StHG', article_number: null,
            title: 'Vorb. zu Art. 13-14a StHG', authors: [], editors: [], version_date: null,
            suggested_citation: null, licence: 'CC-BY-4.0', source_url: 'https://onlinekommentar.ch/de/kommentare/sthg13',
            pdf_url: null, rank: 0.05, snippet: null,
          },
        ],
        total_count: 2, has_more: false, limit: 10, offset: 0,
      };
      const result = extractChEvidence('ch_search_commentary', data);
      expect(result.documents).toHaveLength(0);
      expect(result.citations).toHaveLength(2);
      const [first, second] = result.citations;
      expect(first.text).toContain('Art. 1b BankG');
      expect(first.text).toContain('Tamara Teves');
      expect(first.text).toContain('Редакція 2026-08-23');
      expect(first.text).toContain('Fintech-Lizenz');
      expect(first.text).not.toContain('<b>');
      expect(first.source).toBe('onlinekommentar (CC-BY-4.0)');
      expect(first.npaTitle).toBe('Banking Act (SR 952.0)');
      expect(first.articleNumber).toBe('1b');
      expect(first.url).toBe('https://onlinekommentar.ch/de/kommentare/bankg1b');
      expect(second.npaTitle).toBe('StHG');
      expect(second.articleNumber).toBeUndefined();
    });

    it('yields nothing for an empty page', () => {
      const result = extractChEvidence('ch_search_commentary', { results: [], total_count: 0, has_more: false, limit: 10, offset: 0 });
      expect(result.citations).toHaveLength(0);
    });
  });

  describe('ch_search_materials', () => {
    it('maps hits to Citation[] with the Gazette citation as the badge and the PDF as the link', () => {
      const data = {
        results: [{
          material_id: 5, eli_work_uri: 'https://fedlex.data.admin.ch/eli/fga/2001/318', lang: 'de',
          material_type: 'botschaft', title: 'Botschaft zum Embargogesetz', historical_id: 'BBl 2001 1433',
          date_document: '2000-12-20', publication_date: '2001-04-17',
          pdf_url: 'https://fedlex.data.admin.ch/filestore/x.pdf', stage: 'parsed', rank: 0.1,
          snippet: 'Die <b>Sanktionen</b> werden',
        }],
        total_count: 1, has_more: false, limit: 10, offset: 0,
      };
      const [c] = extractChEvidence('ch_search_materials', data).citations;
      expect(c.text).toContain('Botschaft');
      expect(c.text).toContain('2000-12-20');
      expect(c.text).toContain('Sanktionen');
      expect(c.text).not.toContain('<b>');
      expect(c.articleNumber).toBe('BBl 2001 1433');
      expect(c.url).toBe('https://fedlex.data.admin.ch/filestore/x.pdf');
      expect(c.npaTitle).toBe('Botschaft zum Embargogesetz');
    });

    it('names an untitled material by its citation so the panel never shows an empty source', () => {
      const data = { results: [{ material_id: 6, material_type: 'bericht_br', title: null, historical_id: 'BBl 2010 5876', pdf_url: 'https://x/y.pdf' }], total_count: 1, has_more: false, limit: 10, offset: 0 };
      const [c] = extractChEvidence('ch_search_materials', data).citations;
      expect(c.npaTitle).toBe('BBl 2010 5876');
      expect(c.source).toBe('BBl 2010 5876');
      const untitled = { results: [{ material_id: 7, material_type: 'bericht_br', title: null, historical_id: null, pdf_url: 'https://x/z.pdf' }], total_count: 1, has_more: false, limit: 10, offset: 0 };
      expect(extractChEvidence('ch_search_materials', untitled).citations[0].npaTitle).toBe('Звіт Федеральної ради');
    });
  });

  describe('ch_get_material', () => {
    const MATERIAL = {
      material_id: 5, eli_work_uri: 'https://fedlex.data.admin.ch/eli/fga/2001/318', lang: 'de',
      material_type: 'botschaft', title: 'Botschaft zum Embargogesetz', historical_id: 'BBl 2001 1433',
      date_document: '2000-12-20', publication_date: '2001-04-17', pdf_url: 'https://fedlex.data.admin.ch/filestore/x.pdf',
      stage: 'parsed', text: 'Botschaft ...', text_offset: 0, text_total_chars: 13, truncated: false, text_available: true,
    };

    it('builds one VaultDocument with the citation in the title', () => {
      const doc = extractChEvidence('ch_get_material', MATERIAL).documents[0];
      expect(doc.id).toBe('ch-material-5');
      expect(doc.title).toContain('Botschaft zum Embargogesetz');
      expect(doc.title).toContain('BBl 2001 1433');
      expect(doc.metadata?.body).toBe('Botschaft ...');
      expect(doc.metadata?.pdf_url).toBe(MATERIAL.pdf_url);
    });

    it('notes an unparsed edition and a truncated slice', () => {
      const doc = extractChEvidence('ch_get_material', { ...MATERIAL, text: '', text_available: false, text_total_chars: 0 }).documents[0];
      expect(doc.metadata?.snippet).toContain('ще не завантажено');
      const cut = extractChEvidence('ch_get_material', { ...MATERIAL, text: 'Bots', truncated: true }).documents[0];
      expect(cut.metadata?.snippet).toContain('показано 4 з 13 символів');
    });

    it('returns nothing for an error payload', () => {
      expect(extractChEvidence('ch_get_material', { error: 'not_found', available_langs: [] }).documents).toHaveLength(0);
    });
  });

  describe('ch_get_article_purpose', () => {
    it('yields one Citation per paragraph, naming the act and article and linking the PDF', () => {
      const data = {
        sr_number: '946.231', act_title: 'Embargogesetz', abbreviation: 'EmbG', article: '2', lang: 'de',
        link_method: 'provenance_bbl',
        bbl_references: [{ bbl_reference: 'BBl 2001 1433', action: 'inserted', effective_date: '2003-01-01', material_found: true }],
        unmatchable_references: [],
        materials: [
          { material_id: 5, title: 'Botschaft zum Embargogesetz', historical_id: 'BBl 2001 1433', material_type: 'botschaft',
            pdf_url: 'https://fedlex.data.admin.ch/filestore/x.pdf', text_available: true, matched_via: ['BBl 2001 1433'],
            paragraphs: [{ ordinal: 7, text: 'Art. 2 des Entwurfs überträgt ...' }, { ordinal: 9, text: 'Nach Artikel 2 Absatz 1 ...' }],
            paragraphs_truncated: false },
          { material_id: 6, title: 'Message', historical_id: 'FF 2001 1341', material_type: 'botschaft',
            pdf_url: 'https://fedlex.data.admin.ch/filestore/y.pdf', text_available: false, matched_via: [], paragraphs: [], paragraphs_truncated: false },
        ],
        materials_truncated: false,
      };
      const { citations, documents } = extractChEvidence('ch_get_article_purpose', data);
      expect(documents).toHaveLength(0);
      expect(citations).toHaveLength(3);
      expect(citations[0].text).toContain('Art. 2 des Entwurfs');
      expect(citations[0].npaTitle).toBe('Art. 2 EmbG Embargogesetz (SR 946.231)');
      expect(citations[0].articleNumber).toBe('2');
      expect(citations[0].source).toBe('Botschaft zum Embargogesetz, BBl 2001 1433');
      expect(citations[0].url).toBe('https://fedlex.data.admin.ch/filestore/x.pdf');
      expect(citations[2].text).toContain('ще не завантажено');
    });

    it('yields nothing for no_materials_linked', () => {
      const result = extractChEvidence('ch_get_article_purpose', { error: 'no_materials_linked', bbl_references: [] });
      expect(result.citations).toHaveLength(0);
    });
  });
});
