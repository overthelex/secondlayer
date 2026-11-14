/** /praktykum page: one GET form, answers checked server-side, works without JS. */
import { esc, page, uaDate, BONUS_NOTE, type Crumb } from './seo-page.js';
import { money, LIVING_WAGE, FEE_YEARS } from './court-fee.js';
import { ZAKON_CODES, articleSlug } from './zakon-codes.js';
import { FEE_PATH } from './court-fee-render.js';
import {
  PRAK_COURT, PRAK_COURT_SLUG, FAKE_CAUSE, FEE_TASK_AMOUNT,
  type PraktykumData, type TaskResult,
} from './praktykum.js';

export const PRAK_PATH = '/praktykum';
const CRUMBS: Crumb[] = [{ name: 'LEX', href: '/' }, { name: 'Практикум для адвокатів', href: PRAK_PATH }];
const CK = ZAKON_CODES.find(c => c.slug === 'tsyvilnyi-kodeks')!;
const ART_URL = `/zakon/${CK.slug}/${articleSlug('625')}`;

interface Task { id: string; title: string; text: string; how: string; input: (v: string) => string }

const textInput = (id: string, placeholder: string) => (v: string) =>
  `<input name="${id}" id="${id}" value="${esc(v)}" placeholder="${esc(placeholder)}" autocomplete="off">`;

function tasks(d: PraktykumData, year: number): Task[] {
  const opts = d.realVp.length === 2 && d.fakeIsUnused ? [d.realVp[0], FAKE_CAUSE, d.realVp[1]] : [];
  const list: Task[] = [
    {
      id: 't1', title: 'Знайдіть норму',
      text: 'Клієнт прострочив оплату за договором поставки. Яка стаття Цивільного кодексу дозволяє стягнути з боржника 3 % річних та інфляційні втрати? Вкажіть номер статті.',
      how: `Пошукайте в <a href="/zakon/${CK.slug}">змісті ЦК</a> або запитайте в LEX: «стягнення 3% річних за прострочення грошового зобов’язання».`,
      input: textInput('t1', 'наприклад, 530'),
    },
    {
      id: 't2', title: 'Знайдіть позицію Великої Палати',
      text: 'Знайдіть будь-яку постанову Великої Палати Верховного Суду, яка застосовує цю статтю. Вкажіть номер справи.',
      how: `Перелік постанов ВП є внизу <a href="${ART_URL}">сторінки статті</a>. У LEX можна попросити: «позиції ВП ВС щодо ст. 625 ЦК».`,
      input: textInput('t2', 'наприклад, 910/12345/20'),
    },
    {
      id: 't3', title: 'Перевірте, чи позиція актуальна',
      text: 'Посилатися варто на найновішу позицію: Велика Палата могла відступити від попередніх висновків. Вкажіть дату найновішої постанови ВП, що застосовує цю статтю.',
      how: 'Перелік відсортовано за датою. У LEX є перевірка, чи не відступив Верховний Суд від позиції.',
      input: textInput('t3', 'ДД.ММ.РРРР'),
    },
    {
      id: 't4', title: 'Розрахуйте судовий збір',
      text: `Фізична особа подає через «Електронний суд» апеляційну скаргу на рішення в майновому спорі. Оспорювана сума ${money(FEE_TASK_AMOUNT)}. Скільки становить судовий збір у ${year} році?`,
      how: `Скористайтеся <a href="${FEE_PATH}">калькулятором судового збору</a> (ПМ ${money(LIVING_WAGE[year])}).`,
      input: textInput('t4', 'сума в гривнях'),
    },
    {
      id: 't5', title: 'Знайдіть засідання',
      text: `Вкажіть номер будь-якої справи, засідання в якій призначено найближчим часом у суді «${PRAK_COURT}».`,
      how: `Розклад є на <a href="/sud/${PRAK_COURT_SLUG}">сторінці суду</a>, блок «Найближчі засідання». У LEX можна шукати засідання за номером справи, суддею чи учасником.`,
      input: textInput('t5', 'номер справи'),
    },
  ];
  if (opts.length) {
    list.push({
      id: 't6', title: 'Розпізнайте вигадане рішення',
      text: 'AI-асистент навів три постанови Великої Палати щодо ст. 625 ЦК. Одну з них він вигадав. Яку?',
      how: 'Кожне посилання з відповіді AI перевіряйте за номером справи в ЄДРСР або на сторінках постанов ВП. LEX дає посилання на текст кожного рішення.',
      input: v => `<div class="opts">${opts.map(o => `<label class="chk"><input type="radio" name="t6" value="${esc(o)}"${o === v ? ' checked' : ''}> Постанова ВП ВС у справі № ${esc(o)}</label>`).join('')}</div>`,
    });
  }
  return list;
}

function resultBadge(r: TaskResult | undefined): string {
  if (!r) return '';
  return r.ok
    ? `<p class="ok">✓ Правильно. ${esc(r.explain)}</p>`
    : `<p class="warn">✗ Не зовсім. ${esc(r.explain)}</p>`;
}

export function renderPraktykum(d: PraktykumData, q: Record<string, unknown>, results: TaskResult[] | null, canCertify = false): string {
  const year = FEE_YEARS[0];
  const ts = tasks(d, year);
  const byId = new Map((results ?? []).map(r => [r.id, r]));
  const score = results ? results.filter(r => r.ok && ts.some(t => t.id === r.id)).length : 0;
  const summary = results
    ? `<section id="result" class="cta"><h2>Результат: ${score} з ${ts.length}</h2><p>${score === ts.length
      ? 'Усі завдання виконано. Так виглядає базова перевірка позиції перед поданням: норма, практика ВП, її актуальність, збір і контроль посилань.'
      : 'Перегляньте підказки біля завдань і спробуйте ще раз.'}</p>${score === ts.length && canCertify ? certForm(q, ts.map(t => t.id)) : ''}</section>`
    : '';
  const body = ts.map((t, i) => `<section class="task" id="${t.id}">
<h2>${i + 1}. ${esc(t.title)}</h2>
<p>${esc(t.text)}</p>
<p class="meta">Як виконати: ${t.how}</p>
${t.input(String(q[t.id] ?? ''))}
${resultBadge(byId.get(t.id))}
</section>`).join('\n');
  return page({
    title: 'Практикум для адвокатів: AI-пошук і перевірка судової практики | LEX',
    description: 'Безкоштовний інтерактивний практикум: знайдіть норму й позицію Великої Палати ВС, перевірте її актуальність, розрахуйте судовий збір, знайдіть засідання й розпізнайте вигадане AI рішення.',
    path: PRAK_PATH,
    crumbs: CRUMBS,
    ogType: 'website',
    source: 'Завдання перевіряються за даними ЄДРСР, розкладу засідань судів і Закону «Про судовий збір».',
    jsonLd: [{
      '@context': 'https://schema.org', '@type': 'Course', name: 'AI у практиці адвоката: пошук і перевірка судової практики',
      description: 'Інтерактивний практикум на реальних даних українських судів і реєстрів.', inLanguage: 'uk',
      provider: { '@type': 'Organization', name: 'LEX', url: 'https://legal.org.ua' },
      isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'UAH', category: 'Free' },
      hasCourseInstance: { '@type': 'CourseInstance', courseMode: 'online', courseWorkload: 'PT30M' },
    }],
    body: `<style>.task{border-bottom:1px solid var(--line);padding:8px 0 16px}.task input:not([type=radio]){font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:inherit;width:100%;max-width:360px}.opts{display:grid;gap:6px}.ok{color:#1a7f37;font-weight:600}.warn{font-weight:600}form .btn{background:var(--accent);color:var(--accent-fg);border:0;padding:10px 18px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;margin-top:16px}</style>
<h1>Практикум для адвокатів: AI-пошук і перевірка судової практики</h1>
<p class="lead">${ts.length} завдань на реальних даних, приблизно 30 хвилин. Ви знайдете норму й позицію Великої Палати, перевірите її актуальність, розрахуєте судовий збір, знайдете засідання та навчитеся помічати вигадані AI рішення. Відповіді перевіряються автоматично.</p>
<p class="meta">Завдання можна виконувати на відкритих сторінках legal.org.ua або в LEX. За повний результат можна отримати іменний сертифікат. ${esc(BONUS_NOTE)}</p>
${summary}
<form method="get" action="${PRAK_PATH}#result">
<input type="hidden" name="check" value="1">
${body}
<button class="btn" type="submit">Перевірити відповіді</button>
</form>
<section class="cta"><h2>Для рад адвокатів і комітетів</h2><p>Практикум можна провести як заняття: є сценарій на 60–90 хвилин, слайди й відповіді для модератора. Напишіть на igor@legal.org.ua.</p><a class="btn" href="/login">Спробувати LEX безкоштовно</a></section>`,
  });
}

function certForm(q: Record<string, unknown>, ids: string[]): string {
  const hidden = ids.map(id => `<input type="hidden" name="${id}" value="${esc(String(q[id] ?? ''))}">`).join('');
  return `<form method="get" action="${PRAK_PATH}" class="certform"><input type="hidden" name="check" value="1"><input type="hidden" name="cert" value="issue">${hidden}
<label for="name">Ім’я та прізвище для сертифіката</label><input id="name" name="name" required maxlength="80" placeholder="Олена Коваленко">
<button class="btn" type="submit">Отримати сертифікат</button>
<p class="meta">Ім’я буде лише в адресі сертифіката, ми його не зберігаємо.</p></form>`;
}

export function renderCertificate(name: string, date: string, code: string): string {
  return page({
    title: `Сертифікат: ${name} | Практикум LEX`,
    description: 'Сертифікат про проходження практикуму «AI у практиці адвоката: пошук і перевірка судової практики».',
    path: PRAK_PATH,
    crumbs: [...CRUMBS, { name: 'Сертифікат', href: PRAK_PATH }],
    noindex: true,
    ogType: 'website',
    source: 'Сертифікат можна перевірити за його адресою: код зіставляється з іменем і датою.',
    jsonLd: [],
    body: `<style>.cert{border:2px solid var(--accent);border-radius:16px;padding:40px 28px;margin:24px 0;text-align:center}.cert h1{margin:8px 0 4px}.cert .who{font-size:1.8rem;font-weight:700;margin:18px 0}.cert .meta{margin-top:20px}@media print{header,footer,nav,.noprint{display:none!important}.cert{border-color:#000}}</style>
<div class="cert">
<p class="meta">LEX · legal.org.ua</p>
<h1>Сертифікат</h1>
<p>засвідчує, що</p>
<p class="who">${esc(name)}</p>
<p>${esc(uaDate(date))} успішно виконав(ла) всі завдання практикуму<br><strong>«AI у практиці адвоката: пошук і перевірка судової практики»</strong></p>
<p>Пошук норми й позиції Великої Палати Верховного Суду, перевірка актуальності позиції, розрахунок судового збору, пошук засідань, розпізнавання вигаданих AI рішень.</p>
<p class="meta">Код перевірки: ${esc(code)}. Сертифікат не є документом про підвищення кваліфікації адвоката.</p>
</div>
<p class="noprint"><button class="btn" onclick="window.print()" style="background:var(--accent);color:var(--accent-fg);border:0;padding:10px 18px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer">Друкувати або зберегти PDF</button> &nbsp; <a href="${PRAK_PATH}">До практикуму</a></p>`,
  });
}

export function renderCertInvalid(): string {
  return page({
    title: 'Сертифікат не знайдено | Практикум LEX', description: 'Код сертифіката не збігається.', path: PRAK_PATH,
    crumbs: CRUMBS, noindex: true, jsonLd: [],
    body: `<h1>Сертифікат не підтверджено</h1><p>Код не відповідає імені й даті. Перевірте адресу або <a href="${PRAK_PATH}">пройдіть практикум</a>.</p>`,
  });
}
