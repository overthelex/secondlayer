/** /kalkuliator-sudovoho-zboru: server-rendered calculator, works without JS (GET form). */
import { esc, page, BONUS_NOTE, type Crumb } from './seo-page.js';
import {
  courtFee, money, FeeError, LIVING_WAGE, FEE_YEARS,
  type FeeInput, type FeeCourt, type FeePayer, type FeeDoc, type ClaimKind, type FeeResult,
} from './court-fee.js';

export const FEE_PATH = '/kalkuliator-sudovoho-zboru';
const CRUMBS: Crumb[] = [{ name: 'LEX', href: '/' }, { name: 'Калькулятор судового збору', href: FEE_PATH }];
const LAW = 'https://zakon.rada.gov.ua/laws/show/3674-17#n4';

const COURTS: Array<[FeeCourt, string]> = [['civil', 'Загальний суд (цивільна справа)'], ['commercial', 'Господарський суд'], ['admin', 'Адміністративний суд']];
const PAYERS: Array<[FeePayer, string]> = [['person', 'Фізична особа'], ['fop', 'Фізична особа – підприємець'], ['legal', 'Юридична особа або суб’єкт владних повноважень']];
const DOCS: Array<[FeeDoc, string]> = [
  ['claim', 'Позовна заява'],
  ['appeal', 'Апеляційна скарга на рішення'],
  ['cassation', 'Касаційна скарга на рішення'],
  ['ruling_appeal', 'Апеляційна або касаційна скарга на ухвалу'],
  ['order', 'Заява про видачу судового наказу'],
  ['order_cancel', 'Заява про скасування судового наказу'],
  ['security', 'Заява про забезпечення позову або доказів'],
  ['divorce', 'Позов про розірвання шлюбу'],
  ['divorce_property', 'Позов про поділ майна при розірванні шлюбу'],
];
const KINDS: Array<[ClaimKind, string]> = [['property', 'майнового характеру'], ['nonproperty', 'немайнового характеру']];

const pick = <T extends string>(v: unknown, opts: Array<[T, string]>, dflt: T): T =>
  (opts.find(([k]) => k === v)?.[0]) ?? dflt;

/** Query string → input. Missing fields take the most common case. */
export function parseFeeQuery(q: Record<string, unknown>): FeeInput {
  const year = Number(q.year);
  const amount = Number(String(q.amount ?? '').replace(/\s/g, '').replace(',', '.'));
  return {
    court: pick(q.court, COURTS, 'civil'),
    payer: pick(q.payer, PAYERS, 'person'),
    doc: pick(q.doc, DOCS, 'claim'),
    kind: pick(q.kind, KINDS, 'property'),
    amount: Number.isFinite(amount) ? amount : 0,
    social: q.social === '1',
    electronic: q.e === '1',
    year: LIVING_WAGE[year] ? year : FEE_YEARS[0],
  };
}

const select = (name: string, opts: Array<[string, string]>, v: string) =>
  `<select name="${name}" id="f-${name}">${opts.map(([k, l]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

function form(i: FeeInput): string {
  const years: Array<[string, string]> = FEE_YEARS.map(y => [String(y), `${y} (ПМ ${money(LIVING_WAGE[y])})`]);
  return `<form class="calc" method="get" action="${FEE_PATH}#result">
<label for="f-court">Суд</label>${select('court', COURTS, i.court)}
<label for="f-payer">Хто подає</label>${select('payer', PAYERS, i.payer)}
<label for="f-doc">Документ</label>${select('doc', DOCS, i.doc)}
<label for="f-kind">Вимога (для позову і скарг на рішення)</label>${select('kind', KINDS, i.kind)}
<label for="f-amount">Ціна позову або оспорювана сума, грн</label><input id="f-amount" name="amount" inputmode="decimal" value="${i.amount ? esc(String(i.amount)) : ''}" placeholder="100000">
<label for="f-year">Рік подання</label>${select('year', years, String(i.year))}
<label class="chk"><input type="checkbox" name="e" value="1"${i.electronic ? ' checked' : ''}> Подаю через «Електронний суд» (коефіцієнт 0,8)</label>
<label class="chk"><input type="checkbox" name="social" value="1"${i.social ? ' checked' : ''}> Спір про соціальні, трудові, сімейні, житлові права або шкоду здоров’ю (менші обмеження для скарг фізичних осіб)</label>
<button class="btn" type="submit">Розрахувати</button>
</form>`;
}

function resultHtml(r: FeeResult | null, err: string | null): string {
  if (err) return `<section id="result" class="warn"><p>${esc(err)}</p></section>`;
  if (!r) return '';
  return `<section id="result" class="cta"><h2>Судовий збір: ${esc(money(r.fee))}</h2>
<ol>${r.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
<p class="meta">Підстава: <a href="${LAW}" rel="nofollow">${esc(r.basis)}</a>. Пільги за ст. 5 Закону не враховано. Перевірте реквізити для сплати на сайті суду.</p></section>`;
}

/** Key 2026 rates as a static table: the answer most visitors need, readable without the form. */
function ratesTable(year: number): string {
  const row = (label: string, o: Partial<FeeInput>, note = '') => {
    const r = courtFee({ court: 'civil', payer: 'person', doc: 'claim', kind: 'property', amount: 1, social: false, electronic: false, year, ...o });
    const e = courtFee({ court: 'civil', payer: 'person', doc: 'claim', kind: 'property', amount: 1, social: false, electronic: true, year, ...o });
    return `<tr><td>${esc(label)}</td><td>${esc(money(r.fee))}${note}</td><td>${esc(money(e.fee))}</td></tr>`;
  };
  const pm = LIVING_WAGE[year];
  return `<div class="scroll"><table class="stats"><thead><tr><th>Документ, ${year} рік</th><th>Ставка</th><th>Через «Електронний суд»</th></tr></thead><tbody>
${row('Майновий позов фізичної особи (мінімум; 1 % ціни позову, не більше 5 ПМ)', {})}
${row('Майновий позов юридичної особи (мінімум; 1,5 % ціни позову, не більше 350 ПМ)', { payer: 'legal' })}
${row('Немайновий позов фізичної особи', { kind: 'nonproperty' })}
${row('Немайновий позов юридичної особи або ФОП', { kind: 'nonproperty', payer: 'legal' })}
${row('Позов про розірвання шлюбу', { doc: 'divorce' })}
${row('Заява про видачу судового наказу', { doc: 'order' })}
${row('Заява про забезпечення позову, фізична особа', { doc: 'security' })}
${row('Скарга на ухвалу, фізична особа', { doc: 'ruling_appeal' })}
</tbody></table></div>
<p class="meta">Прожитковий мінімум для працездатних осіб на 1 січня ${year} року: ${esc(money(pm))}. Мінімальні ставки майнових позовів наведено для невеликої ціни позову; точну суму дає калькулятор.</p>`;
}

const FAQ: Array<[string, string]> = [
  ['Від чого рахується судовий збір у 2026 році?', `Від прожиткового мінімуму для працездатних осіб на 1 січня року, в якому подається заява чи скарга. У 2026 році це ${money(LIVING_WAGE[2026])}.`],
  ['Скільки коштує позов фізичної особи у 2026 році?', `Майновий позов: 1 % ціни позову, але не менше ${money(0.4 * LIVING_WAGE[2026])} і не більше ${money(5 * LIVING_WAGE[2026])}. Немайновий: ${money(0.4 * LIVING_WAGE[2026])}.`],
  ['Яка знижка при поданні через «Електронний суд»?', 'До ставки застосовується коефіцієнт 0,8, тобто збір менший на 20 % (ч. 3 ст. 4 Закону «Про судовий збір»).'],
  ['Як рахується збір за апеляційну і касаційну скаргу?', '150 % (апеляція) або 200 % (касація) ставки, що підлягала сплаті при поданні позову, від оспорюваної суми. Для фізичних осіб у майнових спорах діють обмеження 8 і 10 ПМ, а в соціальних, трудових, сімейних і житлових спорах 3 і 5 ПМ. В адміністративних справах обмеження 15 і 20 ПМ.'],
  ['Чи враховує калькулятор пільги?', 'Ні. Звільнення від сплати за ст. 5 Закону (наприклад, у спорах про стягнення заробітної плати чи для осіб з інвалідністю) калькулятор не застосовує: перевірте, чи не належите ви до пільгових категорій.'],
];

export function renderCourtFee(q: Record<string, unknown>): string {
  const submitted = q.doc !== undefined;
  const i = parseFeeQuery(q);
  let r: FeeResult | null = null;
  let err: string | null = null;
  if (submitted) {
    try { r = courtFee(i); } catch (e) { if (e instanceof FeeError) err = e.message; else throw e; }
  }
  const y = FEE_YEARS[0];
  const pm = LIVING_WAGE[y];
  return page({
    title: `Калькулятор судового збору ${y}: розрахунок онлайн | LEX`,
    description: `Розрахуйте судовий збір за позов, апеляційну чи касаційну скаргу в ${y} році: загальні, господарські й адміністративні суди, коефіцієнт 0,8 для «Електронного суду». ПМ ${money(pm)}.`,
    path: FEE_PATH,
    crumbs: CRUMBS,
    ogType: 'website',
    source: 'Ставки за ст. 4 Закону України «Про судовий збір»; прожитковий мінімум за законами про Державний бюджет.',
    jsonLd: [
      { '@context': 'https://schema.org', '@type': 'WebApplication', name: 'Калькулятор судового збору', url: `https://legal.org.ua${FEE_PATH}`, applicationCategory: 'FinanceApplication', inLanguage: 'uk', offers: { '@type': 'Offer', price: '0', priceCurrency: 'UAH' } },
      { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map(([q2, a]) => ({ '@type': 'Question', name: q2, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    ],
    body: `<style>form.calc{display:grid;gap:6px;max-width:560px;margin:12px 0 20px}form.calc select,form.calc input:not([type=checkbox]){font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:inherit}form.calc label{font-weight:600;margin-top:6px}form.calc label.chk{font-weight:400}form.calc .btn{justify-self:start;margin-top:10px;background:var(--accent);color:var(--accent-fg);border:0;padding:10px 18px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer}</style>
<h1>Калькулятор судового збору ${y}</h1>
<p class="lead">У ${y} році судовий збір рахується від прожиткового мінімуму ${esc(money(pm))}: майновий позов фізичної особи коштує 1 % ціни позову (від ${esc(money(0.4 * pm))} до ${esc(money(5 * pm))}), юридичної особи 1,5 % (від ${esc(money(pm))}). Через «Електронний суд» на 20 % менше.</p>
${form(i)}
${resultHtml(r, err)}
<h2>Основні ставки судового збору у ${y} році</h2>
${ratesTable(y)}
<h2>Питання та відповіді</h2>${FAQ.map(([q2, a]) => `<details><summary>${esc(q2)}</summary><p>${esc(a)}</p></details>`).join('')}
<section class="cta"><h2>Судова практика щодо судового збору</h2><p>LEX знаходить постанови Верховного Суду про повернення, зменшення та відстрочення судового збору й відповідає з посиланнями на рішення.</p><a class="btn" href="/login">Спробувати LEX безкоштовно</a><p class="meta">${esc(BONUS_NOTE)}</p></section>`,
  });
}
