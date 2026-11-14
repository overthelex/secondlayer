/**
 * Live numbers for the public home, pricing and landing pages. Nothing on those
 * pages is typed in by hand: coverage comes from the data tables, prices from
 * tool_pricing (the same rows billing charges from) and the NBU rate.
 */
import type { BaseDatabase } from '@secondlayer/shared';
import { V2_TOOL_NAMES } from '../../api/curated-mcp-tools.js';
import { CurrencyService } from '../currency-service.js';
import { PUBLISHABLE } from './advocates-repository.js';

export interface Coverage {
  edrsrDocs: number;
  npaActs: number;
  judges: number;
  courts: number;
  vpDecisions: number;
  advocates: number;
}

export interface PriceRow { tool: string; name: string; usd: number }

export interface Pricing {
  rows: PriceRow[];
  /** Average AI-chat request (tool_pricing.ai_chat is an average, chat is billed by usage). */
  chatAvgUsd: number | null;
  markupPercent: number;
  rate: number | null;
  rateDate: string | null;
}

const num = (v: unknown) => Number(v) || 0;

export class MarketingRepository {
  constructor(private readonly db: BaseDatabase, private readonly currency = new CurrencyService()) {}

  async coverage(): Promise<Coverage> {
    const q = async (sql: string) => {
      try { return num((await this.db.query(sql)).rows[0]?.n); } catch { return 0; }
    };
    const [edrsrDocs, npaActs, judges, courts, vpDecisions, advocates] = await Promise.all([
      q(`SELECT sum(c.reltuples)::bigint AS n FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid WHERE i.inhparent = 'edrsr_documents'::regclass`),
      q(`SELECT count(*) AS n FROM npa.act`),
      q(`SELECT count(*) AS n FROM seo_judges`),
      q(`SELECT count(*) AS n FROM seo_courts`),
      q(`SELECT count(*) AS n FROM seo_vp_decisions`),
      q(`SELECT count(*) AS n FROM opendata_advocates a WHERE ${PUBLISHABLE}`),
    ]);
    return { edrsrDocs, npaActs, judges, courts, vpDecisions, advocates };
  }

  async pricing(): Promise<Pricing> {
    const r = await this.db.query(
      `SELECT tool_name, display_name, base_cost_usd, markup_percent FROM tool_pricing
        WHERE is_active = true AND fixed_price IS NULL AND base_cost_usd > 0`,
    );
    const t = await this.db.query(`SELECT markup_percentage FROM billing_tiers WHERE tier_key = 'startup' AND is_active`);
    const markupPercent = num(t.rows[0]?.markup_percentage);
    const tier = 1 + markupPercent / 100;
    let chatAvgUsd: number | null = null;
    const rows: PriceRow[] = [];
    for (const x of r.rows) {
      const usd = num(x.base_cost_usd) * (1 + num(x.markup_percent) / 100) * tier;
      if (x.tool_name === 'ai_chat') chatAvgUsd = usd;
      else if (V2_TOOL_NAMES.has(x.tool_name)) rows.push({ tool: x.tool_name, name: x.display_name, usd });
    }
    let rate: number | null = null;
    let rateDate: string | null = null;
    try {
      const info = await Promise.race([
        this.currency.getUsdToUahRate(),
        new Promise<null>(res => setTimeout(() => res(null), 3000)),
      ]);
      if (info && info.source !== 'default' && info.rate > 0) {
        rate = info.rate;
        rateDate = /^\d{4}-\d{2}-\d{2}/.test(info.lastUpdated) ? info.lastUpdated.slice(0, 10) : null;
      }
    } catch { /* prices fall back to USD */ }
    return { rows, chatAvgUsd, markupPercent, rate, rateDate };
  }
}
