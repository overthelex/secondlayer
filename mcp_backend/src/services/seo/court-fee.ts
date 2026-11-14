/**
 * Court fee (судовий збір) per art. 4 of the Law «Про судовий збір» (3674-17).
 * Pure: no I/O. Rates are shares of the living wage for able-bodied persons
 * on 1 January of the filing year (art. 4 part 1).
 */

/** Прожитковий мінімум для працездатних осіб на 1 січня (закони про Держбюджет). */
export const LIVING_WAGE: Record<number, number> = { 2024: 3028, 2025: 3028, 2026: 3328 };
export const FEE_YEARS = Object.keys(LIVING_WAGE).map(Number).sort((a, b) => b - a);

export type FeeCourt = 'civil' | 'commercial' | 'admin';
export type FeePayer = 'person' | 'fop' | 'legal';
export type FeeDoc =
  | 'claim' | 'divorce' | 'divorce_property' | 'order' | 'order_cancel' | 'security'
  | 'appeal' | 'cassation' | 'ruling_appeal';
export type ClaimKind = 'property' | 'nonproperty';

export interface FeeInput {
  court: FeeCourt;
  payer: FeePayer;
  doc: FeeDoc;
  /** Claim kind for a claim, an appeal or a cassation. */
  kind: ClaimKind;
  /** Ціна позову або оспорювана сума, грн. */
  amount: number;
  /** Social, labour, family or housing rights, or health damage: lower caps for appeals of individuals. */
  social: boolean;
  /** Filed through «Електронний суд»: coefficient 0.8 (art. 4 part 3). */
  electronic: boolean;
  year: number;
}

export interface FeeResult {
  fee: number;
  /** Fee before the 0.8 coefficient. */
  base: number;
  steps: string[];
  basis: string;
}

export class FeeError extends Error {}

const round2 = (x: number) => Math.round(x * 100) / 100;
const uah = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (x: number) => `${uah.format(x)} грн`;

function pct(amount: number, rate: number, min: number, max: number | null, pm: number, steps: string[]): number {
  const raw = amount * rate / 100;
  const lo = min * pm;
  const hi = max === null ? Infinity : max * pm;
  const v = Math.min(Math.max(raw, lo), hi);
  steps.push(`${rate} % від ${money(amount)} = ${money(round2(raw))}; мінімум ${min} ПМ = ${money(round2(lo))}${max === null ? '' : `, максимум ${max} ПМ = ${money(round2(hi))}`} → ${money(round2(v))}`);
  return v;
}

function fixed(times: number, pm: number, steps: string[]): number {
  steps.push(`${times} ПМ × ${money(pm)} = ${money(round2(times * pm))}`);
  return times * pm;
}

/** Fee for the claim itself (pp. 1.1–1.2, 2.1–2.2, 3.1). */
function claimFee(i: FeeInput, pm: number, steps: string[]): number {
  const individual = i.payer !== 'legal';
  if (i.kind === 'property' && !(i.amount > 0)) throw new FeeError('Вкажіть ціну позову або оспорювану суму.');
  if (i.court === 'commercial') {
    return i.kind === 'property' ? pct(i.amount, 1.5, 1, 350, pm, steps) : fixed(1, pm, steps);
  }
  if (i.kind === 'property') {
    if (individual) return pct(i.amount, 1, 0.4, 5, pm, steps);
    return pct(i.amount, 1.5, 1, i.court === 'admin' ? 10 : 350, pm, steps);
  }
  return fixed(i.payer === 'person' ? 0.4 : 1, pm, steps);
}

const BASIS: Record<FeeCourt, string> = {
  civil: 'п. 1 ч. 2 ст. 4 Закону «Про судовий збір»',
  commercial: 'п. 2 ч. 2 ст. 4 Закону «Про судовий збір»',
  admin: 'п. 3 ч. 2 ст. 4 Закону «Про судовий збір»',
};

export function courtFee(i: FeeInput): FeeResult {
  const pm = LIVING_WAGE[i.year];
  if (!pm) throw new FeeError(`Немає прожиткового мінімуму для ${i.year} року.`);
  const steps = [`Прожитковий мінімум (ПМ) для працездатних осіб на 1 січня ${i.year} року: ${money(pm)}.`];
  const individual = i.payer !== 'legal';
  let base: number;
  switch (i.doc) {
    case 'claim':
      base = claimFee(i, pm, steps);
      break;
    case 'divorce':
    case 'divorce_property':
      if (i.court !== 'civil') throw new FeeError('Позови про розірвання шлюбу розглядають загальні суди.');
      if (i.doc === 'divorce') base = fixed(0.4, pm, steps);
      else {
        if (!(i.amount > 0)) throw new FeeError('Вкажіть вартість майна, що ділиться.');
        base = pct(i.amount, 1, 0.4, 3, pm, steps);
      }
      break;
    case 'order':
      if (i.court === 'admin') throw new FeeError('Судовий наказ в адміністративному судочинстві не видається.');
      base = fixed(0.1, pm, steps);
      break;
    case 'order_cancel':
      if (i.court === 'admin') throw new FeeError('Судовий наказ в адміністративному судочинстві не видається.');
      base = fixed(0.05, pm, steps);
      break;
    case 'security':
      base = fixed(i.court === 'admin' ? 0.3 : i.court === 'civil' && i.payer === 'person' ? 0.2 : 0.5, pm, steps);
      break;
    case 'ruling_appeal':
      base = fixed(i.court === 'civil' && i.payer === 'person' ? 0.2 : 1, pm, steps);
      break;
    case 'appeal':
    case 'cassation': {
      const share = i.doc === 'appeal' ? 150 : 200;
      steps.push('Ставка за позов від оспорюваної суми:');
      const claim = claimFee(i, pm, steps);
      base = claim * share / 100;
      steps.push(`${share} % від ${money(round2(claim))} = ${money(round2(base))}`);
      let cap: number | null = null;
      if (i.court === 'admin') cap = i.doc === 'appeal' ? 15 : 20;
      else if (i.court === 'civil' && individual && i.kind === 'property') {
        cap = i.doc === 'appeal' ? (i.social ? 3 : 8) : (i.social ? 5 : 10);
      }
      if (cap !== null && base > cap * pm) {
        base = cap * pm;
        steps.push(`Обмеження ${cap} ПМ = ${money(round2(base))}`);
      }
      break;
    }
    default:
      throw new FeeError('Невідомий вид документа.');
  }
  base = round2(base);
  let fee = base;
  if (i.electronic) {
    fee = round2(base * 0.8);
    steps.push(`Подання через «Електронний суд»: × 0,8 = ${money(fee)}`);
  }
  return { fee, base, steps, basis: BASIS[i.court] };
}
