/**
 * /praktykum/slaidy: the practicum deck for a moderator to present, in the
 * same design as the Slides artifact. The public page leaves out the answers
 * and the moderator notes (they would give the certificate away); the
 * moderator edition, with both, is rendered from the same source and printed
 * to PDF for councils that agree to run the session.
 */
import { esc } from './seo-page.js';
import { PRAK_PATH } from './praktykum-render.js';

export const SLIDES_PATH = `${PRAK_PATH}/slaidy`;

interface Slide {
  id: string;
  cls?: string;
  /** Shown to everyone. */
  body: string;
  /** Moderator edition only: replaces nothing, appended inside the slide. */
  answer?: string;
  notes: string;
}

const SLIDES: Slide[] = [
  {
    id: 'cover', cls: 'dark center',
    body: `<p class="eyebrow">ПРАКТИКУМ ДЛЯ АДВОКАТІВ · 60–90 ХВИЛИН</p>
<h1>AI у практиці адвоката: пошук і перевірка судової практики</h1>
<p class="lead">Шість завдань на реальних даних ЄДРСР, розкладу засідань і Закону «Про судовий збір». Відповіді перевіряються автоматично.</p>
<p class="footer">legal.org.ua/praktykum · LEX</p>`,
    notes: 'Привітайтеся, коротко скажіть, що це практичне заняття, а не лекція: учасники самі виконують завдання на ноутбуці чи телефоні. До початку попросіть усіх відкрити legal.org.ua/praktykum. Реєстрація не обов’язкова: завдання 1–6 виконуються на відкритих сторінках сайту. Хто хоче пробувати AI-пошук у LEX, реєструється: на баланс зараховується 430 грн. Тривалість: 60 хвилин без обговорення, до 90 з обговоренням.',
  },
  {
    id: 'plan',
    body: `<p class="eyebrow">ЯК ПРОЙДЕ ЗАНЯТТЯ</p>
<h2>План на 60–90 хвилин</h2>
<table><tr><th style="width:18%">Час</th><th style="width:52%">Що робимо</th><th style="width:30%">Формат</th></tr>
<tr><td>10 хв</td><td>Вступ: де AI помиляється і чому це ризик для адвоката</td><td>модератор</td></tr>
<tr><td>25 хв</td><td>Завдання 1–3: норма, позиція ВП, її актуальність</td><td>самостійно, потім розбір</td></tr>
<tr><td>20 хв</td><td>Завдання 4–5: судовий збір і розклад засідань</td><td>самостійно, потім розбір</td></tr>
<tr><td>15 хв</td><td>Завдання 6: вигадане рішення; правила роботи з AI</td><td>обговорення</td></tr>
<tr><td>5–20 хв</td><td>Перевірка відповідей, сертифікат, запитання</td><td>усі разом</td></tr></table>`,
    notes: 'Покажіть план і скажіть, що на кожен блок учасники спершу працюють самі (5–8 хвилин), а потім ви разом розбираєте відповідь. Відповіді вводять на сторінці legal.org.ua/praktykum і в кінці натискають «Перевірити відповіді»: сайт покаже, що правильно, і пояснить помилки. Якщо час обмежений до 60 хвилин, скоротіть обговорення в останньому блоці.',
  },
  {
    id: 'why', cls: 'alt',
    body: `<p class="eyebrow">НАВІЩО ЦЕ АДВОКАТУ</p>
<h2>AI відповідає впевнено, навіть коли помиляється</h2>
<div class="row">
<div class="card"><p class="label">РИЗИК 1</p><h3>Вигадані рішення</h3><p class="text">Правдоподібний номер справи і дата, яких немає в реєстрі.</p></div>
<div class="card"><p class="label">РИЗИК 2</p><h3>Застаріла позиція</h3><p class="text">Посилання на висновок, від якого Верховний Суд уже відступив.</p></div>
<div class="card"><p class="label">РИЗИК 3</p><h3>Таємниця клієнта</h3><p class="text">Матеріали справи, передані в чат-бот без потреби.</p></div>
</div>
<p class="lead">Відповідальність за посилання в процесуальному документі несе адвокат, а не AI. Тому сьогодні вчимося перевіряти.</p>`,
    notes: 'Головна думка заняття: AI корисний для пошуку, але кожне посилання адвокат перевіряє сам. Попросіть учасників підняти руку, хто вже користувався ChatGPT чи іншим AI у роботі, і чи траплялися вигадані рішення. Не називайте конкретних випадків, якщо не впевнені в деталях. Перейдіть до завдань.',
  },
  {
    id: 't12',
    body: `<p class="eyebrow">ЗАВДАННЯ 1–2 · 12 ХВИЛИН</p>
<h2>Норма і позиція Великої Палати</h2>
<p class="task">Клієнт прострочив оплату за договором поставки. Яка стаття ЦК дозволяє стягнути 3 % річних та інфляційні втрати? Знайдіть будь-яку постанову Великої Палати ВС, що її застосовує.</p>
<div class="hint">Де шукати: зміст Цивільного кодексу на legal.org.ua/zakon, на сторінці статті внизу є перелік постанов Великої Палати.</div>`,
    answer: '<div class="answer">Відповідь: <b>ст. 625 ЦК України</b>. Номер справи: будь-який із переліку постанов ВП внизу сторінки статті, наприклад <b>754/511/23</b>.</div>',
    notes: 'Дайте 5–6 хвилин. Станом на 14.11.2026 у переліку 28 постанов; сайт приймає будь-який номер справи з нього. Розбір: покажіть сторінку статті й перелік, поясніть, що висновки Верховного Суду суди враховують при застосуванні норми (ч. 4 ст. 263 ЦПК). Питання до групи: як ви зазвичай шукаєте позиції ВП?',
  },
  {
    id: 't3', cls: 'alt',
    body: `<p class="eyebrow">ЗАВДАННЯ 3 · 8 ХВИЛИН</p>
<h2>Чи позиція ще актуальна</h2>
<p class="task">Велика Палата могла відступити від попередніх висновків. Вкажіть дату найновішої постанови ВП, що застосовує ст. 625 ЦК.</p>
<div class="hint">Де шукати: перелік на сторінці статті відсортовано від найновішої постанови.</div>`,
    answer: '<div class="answer">Відповідь станом на 14.11.2026: <b>11.02.2026</b>, справа № 754/511/23. Сайт звіряє з найновішою постановою в базі.</div>',
    notes: 'Якщо з’явиться новіша постанова, правильна відповідь зміниться автоматично. Розбір: посилатися варто на найновіший висновок і перед поданням перевіряти, чи не було відступу. У LEX є окремий інструмент перевірки, чи не відступив Верховний Суд від позиції. Питання до групи: як ви перевіряєте актуальність позиції зараз?',
  },
  {
    id: 't4',
    body: `<p class="eyebrow">ЗАВДАННЯ 4 · 10 ХВИЛИН</p>
<h2>Судовий збір за апеляцію</h2>
<p class="task">Фізична особа подає через «Електронний суд» апеляційну скаргу в майновому спорі. Оспорювана сума 400 000 грн. Скільки становить збір у 2026 році?</p>
<div class="hint">Калькулятор: legal.org.ua/kalkuliator-sudovoho-zboru. ПМ на 1 січня 2026 року: 3 328 грн.</div>`,
    answer: `<div class="steps"><div class="step"><p class="num">4 000</p><p class="cap">1 % від 400 000 грн</p></div><p class="arrow">→</p><div class="step"><p class="num">6 000</p><p class="cap">150 % за апеляцію</p></div><p class="arrow">→</p><div class="step final"><p class="num">4 800 грн</p><p class="cap">× 0,8 за «Електронний суд»</p></div></div>`,
    notes: 'Розбір по кроках: ставка за позов фізичної особи 1 % ціни позову в межах від 0,4 до 5 прожиткових мінімумів (від 1 331,20 до 16 640 грн); 4 000 грн у ці межі вкладається. Апеляція: 150 % від ставки за позов від оспорюваної суми, 6 000 грн; обмеження 8 ПМ не досягнуто. Через «Електронний суд» коефіцієнт 0,8: 4 800 грн. Пільги за ст. 5 Закону калькулятор не враховує, нагадайте про це.',
  },
  {
    id: 't5', cls: 'alt',
    body: `<p class="eyebrow">ЗАВДАННЯ 5 · 8 ХВИЛИН</p>
<h2>Найближче засідання</h2>
<p class="task">Вкажіть номер будь-якої справи, засідання в якій призначено найближчим часом у Центральному районному суді м. Миколаєва.</p>
<div class="row">
<div class="card"><p class="label">ДЕ ШУКАТИ</p><p class="text">Сторінка суду на legal.org.ua/sud, блок «Найближчі засідання»: дата й час, номер справи, головуючий, предмет, зала.</p></div>
<div class="card"><p class="label">ЩО ВАРТО ЗНАТИ</p><p class="text">Розклад публікує суд, він може змінитися. Сторони справ на сторінці не показуються.</p></div>
</div>`,
    notes: 'Сайт приймає будь-який номер справи з розкладу цього суду. Розклад оновлюється щотижня, тому не диктуйте номер заздалегідь, покажіть блок на сторінці суду. Така сама сторінка є для кожного суду і судді. Остаточно час засідання перевіряйте на сайті суду.',
  },
  {
    id: 't6', cls: 'dark',
    body: `<p class="eyebrow">ЗАВДАННЯ 6 · 10 ХВИЛИН</p>
<h2>Яке рішення AI вигадав?</h2>
<p class="lead">AI-асистент навів три постанови Великої Палати щодо ст. 625 ЦК. Одну з них він вигадав. Перевірте кожну за номером справи.</p>
<div class="row"><p class="opt">№ 754/511/23</p><p class="opt">№ 910/18342/23</p><p class="opt">№ 911/952/22</p></div>`,
    answer: '<p class="lead">Вигадана: <b class="hl">910/18342/23</b>. Формат правильний, але такої постанови ВП немає.</p>',
    notes: 'Спершу дайте учасникам перевірити самим. Справжні постанови: 754/511/23 (11.02.2026) і 911/952/22 (16.10.2024). Номер 910/18342/23 серед постанов Великої Палати відсутній: так виглядає «галюцинація» AI, правдоподібна за формою. Обговорення: як перевірити посилання за 30 секунд (пошук номера в ЄДРСР на reyestr.court.gov.ua або на сторінках постанов ВП) і що робити, якщо посилання вже є в чернетці документа.',
  },
  {
    id: 'rules',
    body: `<p class="eyebrow">ПРАВИЛА РОБОТИ З AI</p>
<h2>Чотири звички, які захищають адвоката</h2>
<p class="rule"><span class="dot">1</span><span><b>Перевіряйте кожне посилання</b> в першоджерелі: номер справи, дату, текст висновку.</span></p>
<p class="rule"><span class="dot">2</span><span><b>Перевіряйте актуальність</b>: найновіша позиція і чи не було відступу.</span></p>
<p class="rule"><span class="dot">3</span><span><b>Бережіть адвокатську таємницю</b>: не передавайте в чат-боти персональні дані клієнта без потреби.</span></p>
<p class="rule"><span class="dot">4</span><span><b>Висновок робите ви</b>: AI шукає й пропонує, рішення та відповідальність за адвокатом.</span></p>`,
    notes: 'Обговоріть кожне правило коротко. Адвокатська таємниця охороняється ст. 22 Закону «Про адвокатуру та адвокатську діяльність», тому перед використанням будь-якого AI-сервісу варто знати, де обробляються дані і чи зберігаються вони. Для пошуку практики достатньо описати обставини без імен і реквізитів клієнта.',
  },
  {
    id: 'finish', cls: 'accent center',
    body: `<p class="eyebrow">ПІДСУМОК</p>
<h2>Перевірте відповіді й отримайте сертифікат</h2>
<p class="lead">legal.org.ua/praktykum → «Перевірити відповіді». За результат 6 з 6 сайт видає іменний сертифікат з кодом перевірки.</p>
<p>Запитання й проведення практикуму у вашій раді: igor@legal.org.ua</p>
<p class="footer">Сертифікат LEX не є документом про підвищення кваліфікації адвоката.</p>`,
    notes: 'Попросіть усіх натиснути «Перевірити відповіді». Хто набрав 6 з 6, вводить ім’я і отримує сертифікат, який можна роздрукувати або зберегти в PDF. Ім’я не зберігається на сервері. Сертифікат LEX не замінює залікових годин підвищення кваліфікації, якщо захід не акредитовано. Запитання й побажання до завдань: igor@legal.org.ua.',
  },
];

const FONTS = 'https://fonts.googleapis.com/css2?family=Rubik:wght@400..700&family=Inter:wght@400;600&display=swap';

const CSS = `
:root{--dark:#1F2A37;--light:#F7F5F0;--alt:#ECE6DB;--accent:#B5472F;--muted:#4A5568;--soft:#C9D3DD;--peach:#F0A58F}
*{box-sizing:border-box;margin:0}
html,body{background:#11161D;height:100%}
body{font-family:'Inter',Arial,sans-serif;color:var(--dark)}
.slide{width:1920px;height:1080px;padding:128px;display:flex;flex-direction:column;gap:40px;background:var(--light);position:relative;overflow:hidden}
.slide.alt{background:var(--alt)}.slide.dark{background:var(--dark);color:var(--light)}.slide.accent{background:var(--accent);color:var(--light)}.slide.center{justify-content:center}
h1,h2,h3{font-family:'Rubik',Arial,sans-serif}
h1{font-size:104px;font-weight:700;line-height:1.05}h2{font-size:72px;font-weight:600;line-height:1.1}h3{font-size:40px;font-weight:600;line-height:1.2}
p{font-size:32px;line-height:1.45}
.eyebrow{font-size:28px;font-weight:600;color:var(--accent);letter-spacing:2px}
.dark .eyebrow{color:var(--peach)}.accent .eyebrow{color:var(--light)}
.lead{font-size:40px;line-height:1.4;color:var(--muted)}.dark .lead{color:var(--soft)}.accent .lead{color:var(--light)}
.task{font-size:36px;line-height:1.45}
.row{display:flex;gap:40px}
.card{flex:1;background:#FFFFFF;border-radius:20px;padding:40px;display:flex;flex-direction:column;gap:16px}.alt .card{background:var(--light)}
.card .label{font-size:26px;font-weight:600;color:var(--accent);letter-spacing:1px}.card .text{font-size:30px;line-height:1.4;color:var(--muted)}
.hint{background:#FFFFFF;border-left:8px solid var(--accent);border-radius:12px;padding:28px 36px;font-size:30px;line-height:1.4;color:var(--muted)}.alt .hint{background:var(--light)}
.answer{background:var(--dark);color:var(--light);border-radius:20px;padding:32px 40px;font-size:32px;line-height:1.4}.answer b,.hl{color:var(--peach)}
.steps{display:flex;gap:24px;align-items:center}
.step{background:#FFFFFF;border-radius:20px;padding:32px 36px;display:flex;flex-direction:column;gap:8px}
.step .num{font-family:'Rubik',Arial,sans-serif;font-size:56px;font-weight:700}.step .cap{font-size:26px;color:var(--muted)}
.step.final{background:var(--accent)}.step.final .num,.step.final .cap{color:var(--light)}
.arrow{font-size:48px;color:var(--muted)}
table{font-size:30px;border-collapse:collapse;width:100%}th{text-align:left;font-weight:600}th,td{padding:14px 18px;border-bottom:1px solid #CFC7B8;text-align:left}
.footer{position:absolute;left:128px;bottom:64px;width:1664px;font-size:24px;color:var(--muted)}.dark .footer,.accent .footer{color:var(--soft)}.accent .footer{color:var(--light)}
.opt{flex:1;background:#FFFFFF;color:var(--dark);border-radius:16px;padding:28px 36px;font-size:34px}
.rule{display:flex;gap:28px;align-items:flex-start}.dot{flex:none;width:56px;height:56px;border-radius:50%;background:var(--accent);color:var(--light);font-family:'Rubik',Arial,sans-serif;font-weight:700;font-size:30px;display:flex;align-items:center;justify-content:center}
`;

/** Viewer: one slide at a time, scaled to the window; arrows, space, swipe, F for full screen. */
const VIEWER_CSS = `
.stage{position:fixed;top:0;left:0;right:0;bottom:48px}
.slide{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(var(--s,.5));transform-origin:center;display:none}
.slide.on{display:flex}
.bar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:16px;align-items:center;justify-content:center;padding:10px;font:14px Inter,Arial,sans-serif;color:#C9D3DD;background:rgba(17,22,29,.85)}
.bar button{font:inherit;color:#F7F5F0;background:#2B3746;border:0;border-radius:8px;padding:6px 12px;cursor:pointer}.bar a{color:#F0A58F}
noscript .slide{display:flex;position:static;transform:none;margin:0 auto 24px}
`;

const VIEWER_JS = `(()=>{const s=[...document.querySelectorAll('.slide')];let i=Math.max(0,s.findIndex(x=>'#'+x.id===location.hash));if(i<0)i=0;const n=document.getElementById('n');
const fit=()=>{const k=Math.min(innerWidth/1920,(innerHeight-48)/1080);document.documentElement.style.setProperty('--s',k)};
const go=j=>{i=Math.min(s.length-1,Math.max(0,j));s.forEach((x,k)=>x.classList.toggle('on',k===i));n.textContent=(i+1)+' / '+s.length;history.replaceState(null,'','#'+s[i].id)};
addEventListener('resize',fit);addEventListener('keydown',e=>{if(['ArrowRight','PageDown',' '].includes(e.key)){e.preventDefault();go(i+1)}else if(['ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();go(i-1)}else if(e.key==='Home')go(0);else if(e.key==='End')go(s.length-1);else if(e.key==='f'||e.key==='F'){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen()}});
let x0=null;addEventListener('touchstart',e=>{x0=e.touches[0].clientX},{passive:true});addEventListener('touchend',e=>{if(x0===null)return;const d=e.changedTouches[0].clientX-x0;if(Math.abs(d)>40)go(i+(d<0?1:-1));x0=null});
document.getElementById('prev').onclick=()=>go(i-1);document.getElementById('next').onclick=()=>go(i+1);document.getElementById('fs').onclick=()=>document.documentElement.requestFullscreen();
fit();go(i)})();`;

/** Moderator edition for print: each slide on its own page, then a page of notes. */
const PRINT_CSS = `
@page{size:1920px 1080px;margin:0}
html,body{background:var(--light)}
.slide{page-break-after:always;break-after:page}
.notes{width:1920px;height:1080px;padding:128px;page-break-after:always;break-after:page;background:#FFFFFF;display:flex;flex-direction:column;gap:32px}
.notes h3{font-size:44px;color:var(--accent)}.notes p{font-size:34px;line-height:1.55;color:var(--dark)}
`;

export function renderSlides(opts: { moderator?: boolean } = {}): string {
  const mod = !!opts.moderator;
  const slides = SLIDES.map((sl, k) => {
    const html = `<section class="slide ${sl.cls ?? ''}" id="${esc(sl.id)}" aria-label="Слайд ${k + 1}">${sl.body}${mod && sl.answer ? sl.answer : ''}</section>`;
    return mod ? `${html}<section class="notes"><h3>Слайд ${k + 1}: нотатки модератора</h3><p>${esc(sl.notes)}</p></section>` : html;
  }).join('\n');
  const title = mod ? 'Практикум LEX: набір модератора' : 'Слайди практикуму для адвокатів: AI-пошук і перевірка судової практики | LEX';
  const desc = 'Слайди інтерактивного практикуму для адвокатів: шість завдань на реальних даних судів, правила роботи з AI. Для показу на заході ради адвокатів.';
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${mod ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="https://legal.org.ua${SLIDES_PATH}">`}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://legal.org.ua/og-image.png">
<link rel="icon" href="/icon-192x192.png" type="image/png">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${CSS}${mod ? PRINT_CSS : VIEWER_CSS}</style>
</head>
<body>
${mod ? slides : `<main class="stage">${slides}</main>
<div class="bar"><button id="prev" aria-label="Попередній слайд">←</button><span id="n"></span><button id="next" aria-label="Наступний слайд">→</button><button id="fs">На весь екран (F)</button><a href="${PRAK_PATH}">Практикум</a></div>
<noscript><p style="color:#F7F5F0;text-align:center;font:16px Arial">Увімкніть JavaScript, щоб гортати слайди.</p></noscript>
<script>${VIEWER_JS}</script>`}
</body>
</html>`;
}
