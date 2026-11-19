import type { Citation, VaultDocument } from '../../../types/models/Message';
import type { EvidenceResult, ToolResultData } from './types';

const REGISTRY_TOOLS = [
  'openreyestr_search_entities',
  'openreyestr_get_entity_details',
  'openreyestr_search_beneficiaries',
  'openreyestr_search_founders',
  'openreyestr_company_as_of',
  'openreyestr_company_history',
  'openreyestr_search_founders_history',
  'openreyestr_search_beneficiaries_history',
  'openreyestr_get_by_edrpou',
  'openreyestr_get_statistics',
  'openreyestr_search_enforcement_proceedings',
  'openreyestr_search_debtors',
  'openreyestr_search_bankruptcy_cases',
  'openreyestr_search_notaries',
  'openreyestr_search_court_experts',
  'openreyestr_search_arbitration_managers',
  'search_ip_objects',
  'search_trademarks',
  'find_similar_trademarks',
  'get_ip_object',
];

const IP_TYPE_LABEL: Record<number, string> = {
  1: 'Винахід',
  2: 'Корисна модель',
  4: 'Торговельна марка',
  6: 'Промисловий зразок',
};

function ipObjectToDocument(o: any): VaultDocument {
  const isRegistered = o.obj_state === 2;
  const number = o.registration_number || o.app_number;
  const typeLabel = IP_TYPE_LABEL[o.obj_type] || o.obj_type_name || 'Об’єкт ІВ';
  const classes = Array.isArray(o.classes) && o.classes.length ? `Класи: ${o.classes.join(', ')}` : null;
  return {
    id: `ip-${o.id || number || Math.random().toString(36).slice(2, 8)}`,
    title: o.title_ua || number || typeLabel,
    type: 'other',
    metadata: {
      snippet: [
        typeLabel,
        o.similarity != null && `Схожість: ${o.similarity}`,
        isRegistered ? `Свідоцтво/патент № ${o.registration_number || '—'}` : `Заявка № ${o.app_number || '—'}`,
        classes,
        o.owner_name && `Власник: ${o.owner_name}`,
        o.owner_edrpou && `ЄДРПОУ: ${o.owner_edrpou}`,
        o.status && `Статус: ${o.status}`,
      ].filter(Boolean).join(' • '),
      status: o.status,
      edrpou: o.owner_edrpou,
    },
  };
}

const HISTORY_SEARCH_TOOLS = ['openreyestr_search_founders_history', 'openreyestr_search_beneficiaries_history'];

function snapshotSources(parsed: any): string {
  const snaps = Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
  const sources = [...new Set(snaps.map((s: any) => s.source).filter(Boolean))];
  const dates = snaps.map((s: any) => s.date).filter(Boolean);
  return [dates.length && `Знімки ЄДР: ${dates.join(', ')}`, sources.length && `Джерело: ${sources.join('; ')}`].filter(Boolean).join('. ');
}

/** ЄДР history (edr_hist): keeps the snapshot dates, the source and the match caveat. */
function extractHistoryEvidence(toolName: string, parsed: any): EvidenceResult {
  const citations: Citation[] = [];
  const documents: VaultDocument[] = [];
  if (HISTORY_SEARCH_TOOLS.includes(toolName)) {
    const role = toolName === 'openreyestr_search_founders_history' ? 'Засновник' : 'КБВ';
    for (const r of Array.isArray(parsed.results) ? parsed.results : []) {
      documents.push({
        id: `edrhist-${r.edrpou}-${r.name || ''}-${r.first_seen || ''}`,
        title: r.company_name || `ЄДРПОУ ${r.edrpou}`,
        type: 'other',
        metadata: {
          snippet: [
            `${role}: ${r.name || r.code || '—'}${r.country ? ` (${r.country})` : ''}`,
            r.edrpou && `ЄДРПОУ: ${r.edrpou}`,
            r.company_status && `Стан: ${r.company_status}`,
            (r.first_seen || r.last_seen) && `У знімках: ${r.first_seen || '?'} – ${r.last_seen || '?'}`,
            r.current ? 'є в останньому знімку' : 'колишній запис',
            r.match && `Збіг: ${r.match}`,
          ].filter(Boolean).join(' \u2022 '),
          edrpou: r.edrpou,
          status: r.company_status,
        },
      });
    }
  } else if (parsed.found && parsed.edrpou) {
    const f = parsed.fields || {};
    const first = (k: string) => {
      const v = toolName === 'openreyestr_company_as_of' ? f[k]?.values?.[0] : (Array.isArray(f[k]) ? f[k][f[k].length - 1]?.value : undefined);
      return v || undefined;
    };
    const snippet = toolName === 'openreyestr_company_as_of'
      ? [
          `ЄДРПОУ: ${parsed.edrpou}`,
          parsed.snapshot?.date && `Знімок ЄДР: ${parsed.snapshot.date} (на ${parsed.as_of})`,
          first('status') && `Стан: ${first('status')}`,
          first('address'),
          f.head?.values?.length && `Керівники: ${f.head.values.join('; ')}`,
          f.founder?.values?.length && `Засновники: ${f.founder.values.join('; ')}`,
          f.beneficiary?.values?.length && `КБВ: ${f.beneficiary.values.join('; ')}`,
        ]
      : [
          `ЄДРПОУ: ${parsed.edrpou}`,
          parsed.status && `Стан: ${parsed.status}`,
          `У знімках: ${parsed.first_seen || '?'} – ${parsed.last_seen || '?'}`,
          ...Object.entries(f).map(([k, runs]: [string, any]) => `${parsed.field_labels?.[k] || k}: ${Array.isArray(runs) ? runs.length : 0} серій`),
        ];
    documents.push({
      id: `edrhist-${toolName}-${parsed.edrpou}-${parsed.as_of || ''}`,
      title: first('name') || parsed.name || `ЄДРПОУ ${parsed.edrpou}`,
      type: 'other',
      metadata: { snippet: snippet.filter(Boolean).join(' \u2022 '), edrpou: parsed.edrpou, status: first('status') || parsed.status },
    });
  }
  const source = toolName === 'openreyestr_company_as_of' && parsed.snapshot
    ? `Знімок ЄДР ${parsed.snapshot.date}. Джерело: ${parsed.snapshot.source}`
    : snapshotSources(parsed);
  const text = [parsed.warning, parsed.note, parsed.message].filter(Boolean).join(' ');
  if (text || source) citations.push({ text: text || source, source: source || 'Історія ЄДР' });
  return { decisions: [], citations, documents };
}

export function extractRegistryEvidence(toolName: string, parsed: ToolResultData): EvidenceResult {
  const citations: Citation[] = [];
  const documents: VaultDocument[] = [];
  if (!REGISTRY_TOOLS.some((t) => toolName === t)) {
    return { decisions: [], citations, documents };
  }
  if (toolName.startsWith('openreyestr_') && (toolName.endsWith('_history') || toolName === 'openreyestr_company_as_of')) {
    return extractHistoryEvidence(toolName, parsed);
  }

  // IP registry objects (trademarks / patents / utility models / designs)
  if (toolName === 'search_ip_objects' || toolName === 'search_trademarks' || toolName === 'find_similar_trademarks') {
    const items = Array.isArray(parsed.results) ? parsed.results : [];
    for (const o of items) documents.push(ipObjectToDocument(o));
    return { decisions: [], citations, documents };
  }
  if (toolName === 'get_ip_object') {
    if (parsed && ((parsed as any).app_number || (parsed as any).registration_number)) {
      documents.push(ipObjectToDocument(parsed));
    }
    return { decisions: [], citations, documents };
  }

  // Entity search results
  const entities = parsed.entities || parsed.results || [];
  if (Array.isArray(entities)) {
    for (const e of entities) {
      documents.push({
        id: `entity-${e.id || e.edrpou || Math.random().toString(36).slice(2, 8)}`,
        title: e.name || e.full_name || e.short_name || 'Юрособа',
        type: 'other',
        metadata: {
          snippet: [e.edrpou && `ЄДРПОУ: ${e.edrpou}`, e.address, e.status].filter(Boolean).join(' \u2022 '),
          edrpou: e.edrpou,
          status: e.status,
        },
      });
    }
  }

  // Single entity details
  if (parsed.name && parsed.edrpou && !parsed.entities) {
    documents.push({
      id: `entity-${parsed.edrpou}`,
      title: parsed.name || parsed.full_name || 'Юрособа',
      type: 'other',
      metadata: {
        snippet: [
          `ЄДРПОУ: ${parsed.edrpou}`,
          parsed.address,
          parsed.status,
          parsed.head && `Керівник: ${parsed.head}`,
        ].filter(Boolean).join(' \u2022 '),
        edrpou: parsed.edrpou,
        status: parsed.status,
      },
    });
  }

  // Beneficiaries
  if (parsed.beneficiaries && Array.isArray(parsed.beneficiaries)) {
    for (const b of parsed.beneficiaries) {
      documents.push({
        id: `benef-${b.id || Math.random().toString(36).slice(2, 8)}`,
        title: b.name || b.full_name || 'Бенефіціар',
        type: 'other',
        metadata: {
          snippet: [b.share && `Частка: ${b.share}%`, b.country, b.entity_name].filter(Boolean).join(' \u2022 '),
        },
      });
    }
  }

  // Statistics
  if (parsed.statistics || parsed.total_count != null) {
    citations.push({
      text: typeof parsed.statistics === 'string'
        ? parsed.statistics
        : `Загалом: ${parsed.total_count || 0}. ${parsed.summary || ''}`.trim(),
      source: 'Статистика реєстру',
    });
  }

  // Enforcement proceedings
  if (parsed.enforcement_proceedings || (parsed.results && Array.isArray(parsed.results) && parsed.results[0]?.proceeding_number)) {
    const proceedings = parsed.enforcement_proceedings || parsed.results || [];
    if (Array.isArray(proceedings)) {
      for (const p of proceedings) {
        documents.push({
          id: `enforcement-${p.id || p.proceeding_number || Math.random().toString(36).slice(2, 8)}`,
          title: `Виконавче провадження ${p.proceeding_number || ''}`,
          type: 'other',
          metadata: {
            snippet: [
              p.debtor_name && `Боржник: ${p.debtor_name}`,
              p.creditor_name && `Стягувач: ${p.creditor_name}`,
              p.proceeding_status && `Статус: ${p.proceeding_status}`,
              p.enforcement_agency && `Виконавець: ${p.enforcement_agency}`,
            ].filter(Boolean).join(' \u2022 '),
            status: p.proceeding_status,
          },
        });
      }
    }
  }

  // Debtors
  if (parsed.debtors || (parsed.results && Array.isArray(parsed.results) && parsed.results[0]?.debtor_name)) {
    const debtors = parsed.debtors || parsed.results || [];
    if (Array.isArray(debtors)) {
      for (const d of debtors) {
        documents.push({
          id: `debtor-${d.id || d.edrpou || Math.random().toString(36).slice(2, 8)}`,
          title: d.debtor_name || 'Боржник',
          type: 'other',
          metadata: {
            snippet: [
              d.edrpou && `ЄДРПОУ: ${d.edrpou}`,
              d.total_debt && `Загальний борг: ${d.total_debt}`,
              d.execution_proceedings && `Проваджень: ${d.execution_proceedings}`,
            ].filter(Boolean).join(' \u2022 '),
          },
        });
      }
    }
  }

  // Bankruptcy cases
  if (parsed.bankruptcy_cases || (parsed.results && Array.isArray(parsed.results) && parsed.results[0]?.case_number)) {
    const cases = parsed.bankruptcy_cases || parsed.results || [];
    if (Array.isArray(cases)) {
      for (const c of cases) {
        documents.push({
          id: `bankruptcy-${c.id || c.case_number || Math.random().toString(36).slice(2, 8)}`,
          title: `Банкрутство ${c.case_number || ''}`,
          type: 'other',
          metadata: {
            snippet: [
              c.debtor_name && `Боржник: ${c.debtor_name}`,
              c.case_status && `Статус: ${c.case_status}`,
              c.sanction && `Санкція: ${c.sanction}`,
            ].filter(Boolean).join(' \u2022 '),
          },
        });
      }
    }
  }

  // Notaries
  if (parsed.notaries || (parsed.results && Array.isArray(parsed.results) && parsed.results[0]?.notary_name)) {
    const notaries = parsed.notaries || parsed.results || [];
    if (Array.isArray(notaries)) {
      for (const n of notaries) {
        documents.push({
          id: `notary-${n.id || n.notary_number || Math.random().toString(36).slice(2, 8)}`,
          title: n.notary_name || 'Нотаріус',
          type: 'other',
          metadata: {
            snippet: [
              n.license_number && `Ліцензія: ${n.license_number}`,
              n.address,
              n.status,
            ].filter(Boolean).join(' \u2022 '),
          },
        });
      }
    }
  }

  // Court experts
  if (parsed.court_experts || (parsed.results && Array.isArray(parsed.results) && parsed.results[0]?.expert_name)) {
    const experts = parsed.court_experts || parsed.results || [];
    if (Array.isArray(experts)) {
      for (const e of experts) {
        documents.push({
          id: `expert-${e.id || e.registration_number || Math.random().toString(36).slice(2, 8)}`,
          title: e.expert_name || 'Судовий експерт',
          type: 'other',
          metadata: {
            snippet: [
              e.registration_number && `Реєстр №: ${e.registration_number}`,
              e.specialization,
              e.status,
            ].filter(Boolean).join(' \u2022 '),
          },
        });
      }
    }
  }

  // Arbitration managers
  if (parsed.arbitration_managers || (parsed.results && Array.isArray(parsed.results) && parsed.results[0]?.manager_name)) {
    const managers = parsed.arbitration_managers || parsed.results || [];
    if (Array.isArray(managers)) {
      for (const m of managers) {
        documents.push({
          id: `manager-${m.id || m.registration_number || Math.random().toString(36).slice(2, 8)}`,
          title: m.manager_name || 'Арбітражний керуючий',
          type: 'other',
          metadata: {
            snippet: [
              m.registration_number && `Реєстр №: ${m.registration_number}`,
              m.address,
              m.status,
            ].filter(Boolean).join(' \u2022 '),
          },
        });
      }
    }
  }

  return { decisions: [], citations, documents };
}
