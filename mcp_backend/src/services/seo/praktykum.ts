/**
 * /praktykum: an interactive practicum for advocates. Every task is checked
 * against our own data (VP decisions, the court schedule, the fee calculator),
 * so answers stay right as the data changes. Pure apart from the repository.
 */
import type { BaseDatabase } from '@secondlayer/shared';
import { createHmac } from 'node:crypto';
import { courtFee } from './court-fee.js';

export const PRAK_NREG = '435-15'; // ЦК
export const PRAK_ART = '625';
export const PRAK_COURT = 'Центральний районний суд м. Миколаєва';
export const PRAK_COURT_SLUG = 'tsentralnyi-raionnyi-sud-m-mykolaieva';
/** A case number in the usual format that no Grand Chamber decision carries (checked at render). */
export const FAKE_CAUSE = '910/18342/23';

export interface PraktykumData {
  /** Newest VP decision applying art. 625 ЦК: YYYY-MM-DD. */
  latestVpDate: string | null;
  /** Two real VP decisions for the «spot the invented one» task. */
  realVp: string[];
  fakeIsUnused: boolean;
}

export class PraktykumRepository {
  constructor(private readonly db: BaseDatabase) {}

  async data(): Promise<PraktykumData> {
    const [latest, real, fake] = await Promise.all([
      this.db.query(
        `SELECT to_char(max(v.adj_date), 'YYYY-MM-DD') AS d FROM seo_vp_articles a JOIN seo_vp_decisions v USING (doc_id)
          WHERE a.nreg = $1 AND a.art_no = $2`, [PRAK_NREG, PRAK_ART]),
      this.db.query(
        `SELECT v.cause_num FROM seo_vp_articles a JOIN seo_vp_decisions v USING (doc_id)
          WHERE a.nreg = $1 AND a.art_no = $2 ORDER BY v.adj_date DESC LIMIT 2`, [PRAK_NREG, PRAK_ART]),
      this.db.query('SELECT 1 FROM seo_vp_decisions WHERE cause_num = $1 LIMIT 1', [FAKE_CAUSE]),
    ]);
    return {
      latestVpDate: latest.rows[0]?.d ?? null,
      realVp: real.rows.map((x: { cause_num: string }) => x.cause_num),
      fakeIsUnused: fake.rows.length === 0,
    };
  }

  async isVpForArticle(causeNum: string): Promise<boolean> {
    const r = await this.db.query(
      `SELECT 1 FROM seo_vp_articles a JOIN seo_vp_decisions v USING (doc_id)
        WHERE a.nreg = $1 AND a.art_no = $2 AND v.cause_num = $3 LIMIT 1`, [PRAK_NREG, PRAK_ART, causeNum]);
    return r.rows.length > 0;
  }

  async courtHasHearing(caseNumber: string): Promise<boolean> {
    const r = await this.db.query(
      'SELECT 1 FROM opendata_court_schedule WHERE court_name = $1 AND case_number = $2 LIMIT 1', [PRAK_COURT, caseNumber]);
    return r.rows.length > 0;
  }
}

/** The fee task: an individual appeals via «Електронний суд» in a property dispute over 400 000 грн. */
export const FEE_TASK_AMOUNT = 400_000;
export function feeTaskAnswer(year: number): number {
  return courtFee({ court: 'civil', payer: 'person', doc: 'appeal', kind: 'property', amount: FEE_TASK_AMOUNT, social: false, electronic: true, year }).fee;
}

export interface TaskResult { id: string; ok: boolean; explain: string }

export const normCause = (s: string) => s.replace(/\s+/g, '').replace(/^№/, '');
const normNum = (s: string) => Number(s.replace(/\s|грн|₴/g, '').replace(',', '.'));
/** Accepts 11.02.2026 or 2026-02-11. */
export function normDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  return m ? t : null;
}

export async function checkAnswers(
  q: Record<string, unknown>, d: PraktykumData, repo: Pick<PraktykumRepository, 'isVpForArticle' | 'courtHasHearing'>, year: number,
): Promise<TaskResult[]> {
  const a = (k: string) => String(q[k] ?? '').trim();
  const out: TaskResult[] = [];

  out.push({ id: 't1', ok: (a('t1').match(/\d+/) ?? [])[0] === '625',
    explain: 'Стаття 625 ЦК: боржник, який прострочив грошове зобов’язання, сплачує борг з урахуванням індексу інфляції та 3 % річних.' });

  const c2 = normCause(a('t2'));
  out.push({ id: 't2', ok: !!c2 && await repo.isVpForArticle(c2),
    explain: 'Номер має бути з переліку постанов Великої Палати внизу сторінки статті 625 ЦК.' });

  out.push({ id: 't3', ok: !!d.latestVpDate && normDate(a('t3')) === d.latestVpDate,
    explain: d.latestVpDate
      ? 'Перелік відсортовано від найновішої постанови: перевіряти, чи позиція актуальна, варто саме з неї.'
      : 'Дані про постанови тимчасово недоступні.' });

  const fee = feeTaskAnswer(year);
  out.push({ id: 't4', ok: Math.abs(normNum(a('t4')) - fee) < 0.01,
    explain: '1 % від 400 000 грн = 4 000 грн (в межах 0,4–5 ПМ), за апеляцію 150 % = 6 000 грн, через «Електронний суд» × 0,8.' });

  const c5 = normCause(a('t5'));
  out.push({ id: 't5', ok: !!c5 && await repo.courtHasHearing(c5),
    explain: 'Номер справи має бути з блоку «Найближчі засідання» на сторінці суду.' });

  out.push({ id: 't6', ok: normCause(a('t6')) === FAKE_CAUSE,
    explain: `Справи № ${FAKE_CAUSE} серед постанов Великої Палати немає. Так виглядає «галюцинація» AI: правдоподібний номер, якого немає в реєстрі. Перевіряйте кожне посилання в ЄДРСР.` });

  return out;
}

// ---------------------------------------------------------------------------
// Certificate: issued on a full score, verifiable from its URL alone.
// ---------------------------------------------------------------------------

const NAME_RE = /^[\p{L}][\p{L}'’ʼ .-]{1,78}[\p{L}.]$/u;

export function cleanName(s: unknown): string | null {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return NAME_RE.test(t) ? t : null;
}

/** null when the server has no secret: certificates are then simply not offered. */
export function certCode(name: string, date: string, secret = process.env.JWT_SECRET): string | null {
  if (!secret) return null;
  return createHmac('sha256', secret).update(`praktykum|v1|${name}|${date}`).digest('hex').slice(0, 12);
}

export function certValid(name: string, date: string, code: string, secret = process.env.JWT_SECRET): boolean {
  const want = certCode(name, date, secret);
  return !!want && /^[0-9a-f]{12}$/.test(code) && want === code;
}
