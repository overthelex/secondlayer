import { subjectOrNull, presidingJudge, shortName } from '../courts-repository.js';
import { hearingsHtml } from '../courts-render.js';
import { translit, slugify } from '../translit.js';
import { statsTable, kindShares, isActive, renderCourt, renderJudge, colleagueWindow, judgeShareText } from '../courts-render.js';
import type { Court, Judge, StatRow } from '../courts-repository.js';

describe('translit (KMU 2010)', () => {
  it('follows the word-start and зг rules', () => {
    expect(translit('Юрій Їжакевич')).toBe('yurii yizhakevych');
    expect(translit('Згурський')).toBe('zghurskyi');
    expect(translit('Знам’янка')).toBe('znamianka');
    expect(translit('Щербаков')).toBe('shcherbakov');
  });
  it('builds URL slugs', () => {
    expect(slugify('Печерський районний суд міста Києва')).toBe('pecherskyi-raionnyi-sud-mista-kyieva');
    expect(slugify('Херсонський окружний адміністративний суд ')).toBe('khersonskyi-okruzhnyi-administratyvnyi-sud');
    expect(slugify('а'.repeat(200), 20).length).toBeLessThanOrEqual(20);
  });
});

const stats: StatRow[] = [
  { year: 2026, justiceKind: 1, decisions: 100 },
  { year: 2026, justiceKind: 2, decisions: 300 },
  { year: 2025, justiceKind: 1, decisions: 50 },
];

describe('court stats', () => {
  it('renders a year × kind table with totals', () => {
    const html = statsTable(stats);
    expect(html).toContain('<th>Цивільне</th><th>Кримінальне</th><th>Усього</th>');
    expect(html).toContain('<td>2025</td><td>50</td><td>–</td><td><strong>50</strong></td>');
  });
  it('summarises kind shares', () => {
    expect(kindShares(stats)).toBe('Кримінальне 67%, Цивільне 33%');
  });
  it('treats a court without decisions for a year as not operating', () => {
    const now = new Date('2026-11-14');
    expect(isActive('2026-10-01', now)).toBe(true);
    expect(isActive('2018-09-30', now)).toBe(false);
    expect(isActive(null, now)).toBe(false);
  });
});

const court: Court = { courtCode: 1, slug: 'pecherskyi', name: 'Печерський районний суд міста Києва', instanceCode: 3, region: 'м. Київ', lastDecision: '2026-11-10', instance: 'Перша' };

describe('renderCourt', () => {
  it('lists judges alphabetically and escapes names', () => {
    const html = renderCourt(court, stats, [{ slug: 'b', fullName: 'Ільєва <Т>' }, { slug: 'a', fullName: 'Батрин О.' }], new Date('2026-11-14'));
    expect(html.indexOf('Батрин')).toBeLessThan(html.indexOf('Ільєва'));
    expect(html).toContain('Ільєва &lt;Т&gt;');
    expect(html).toContain('<link rel="canonical" href="https://legal.org.ua/sud/pecherskyi">');
    expect(html).not.toContain('class="warn"');
  });
  it('marks a liquidated court', () => {
    const html = renderCourt({ ...court, lastDecision: '2018-09-30' }, stats, [], new Date('2026-11-14'));
    expect(html).toContain('Суд не ухвалював рішень понад рік');
  });
});

describe('renderJudge', () => {
  const j: Judge = { dossier: '00993', slug: 'shcherbakov-00993', fullName: 'Щербаков Володимир Валерійович', courtName: 'Рівненський окружний адміністративний суд', court: { slug: 'rivnenskyi', name: 'Рівненський окружний адміністративний суд' }, courtCode: 5, judgeKey: 'щербаков вв', lastSeen: '2026-11-09', registerDate: '2026-11-09' };
  it('links the current court and states the register date', () => {
    const html = renderJudge(j, [{ courtName: j.courtName!, from: '2021-06-01', to: '2026-11-09' }], stats);
    expect(html).toContain('<a href="/sud/rivnenskyi">');
    expect(html).toContain('станом на 09.11.2026');
    expect(html).toContain('"worksFor"');
    expect(html).not.toContain('Місця роботи'); // one court only
  });
  it('says when a judge is no longer in the register', () => {
    const html = renderJudge({ ...j, lastSeen: '2024-01-15' }, [{ courtName: 'Суд А', from: '2021-06-01', to: '2024-01-15' }], []);
    expect(html).toContain('У чинному реєстрі суддів не значиться');
    expect(html).toContain('Місця роботи');
    expect(html).not.toContain('"worksFor"');
  });
});

describe('upcoming hearings', () => {
  it('drops subjects that name a person and keeps the rest', () => {
    expect(subjectOrNull('Про визнання Дроздову Н.О. недієзд. та призн. опікуна')).toBeNull();
    expect(subjectOrNull('про стягнення заборгованості за кредитним договором')).toBe('про стягнення заборгованості за кредитним договором');
    expect(subjectOrNull('  ')).toBeNull();
  });

  it('reads the presiding judge and builds the schedule form of a name', () => {
    expect(presidingJudge('Головуючий суддя: Агєєв О.В., суддя-доповідач: Агєєв О.В.')).toBe('Агєєв О.В.');
    expect(presidingJudge(null)).toBeNull();
    expect(shortName('Берднік Ігор Сергійович')).toBe('Берднік І.С.');
  });

  it('renders nothing without hearings and never a party column', () => {
    expect(hearingsHtml({ items: [], asOf: null }, true)).toBe('');
    const html = hearingsHtml({ asOf: '2026-11-08', items: [{ at: '17.11.2026 09:00', caseNumber: '490/5120/25', presiding: 'Черенкова Н.П.', room: null, subject: null }] }, true);
    expect(html).toContain('490/5120/25');
    expect(html).toContain('08.11.2026');
    expect(html).not.toMatch(/Сторони<\/th>|Учасники/);
  });
});

describe('judge cross-links', () => {
  const judges = 'АБВГДЕЖЗИКЛМНОПРСТ'.split('').map((c, i) => ({ slug: `j${i}`, fullName: `${c}енко ${c}.` }));
  it('lists every colleague when the court is small', () => {
    expect(colleagueWindow(judges.slice(0, 5), 'j2').map(x => x.slug)).toEqual(['j0', 'j1', 'j3', 'j4']);
  });
  it('takes a window around the judge, wrapping, without the judge', () => {
    const w = colleagueWindow(judges, 'j0', 4).map(x => x.slug);
    expect(w).toHaveLength(4);
    expect(w).not.toContain('j0');
    expect(w).toEqual(expect.arrayContaining(['j1', 'j2', 'j17', 'j16']));
  });
  it('states the share of the court decisions and the previous year', () => {
    const judge = [{ year: 2025, justiceKind: 1, decisions: 120 }, { year: 2025, justiceKind: 2, decisions: 30 }, { year: 2024, justiceKind: 1, decisions: 90 }];
    const court = [{ year: 2025, justiceKind: 1, decisions: 2000 }, { year: 2025, justiceKind: 2, decisions: 1000 }];
    const t = judgeShareText(judge, court, new Date('2026-11-16'));
    expect(t).toBe('За 2025 рік у ЄДРСР 150 рішень судді, це 5% усіх рішень суду за цей рік. У 2024 році: 90.');
    expect(judgeShareText(judge, court, new Date('2025-06-01'))).toContain('За 2025 рік (станом на 01.06.2025)');
    expect(judgeShareText([], court)).toBe('');
  });
  it('renders colleagues with a link back to the court', () => {
    const j: Judge = { dossier: '1', slug: 'j3', fullName: 'Генко Г.', courtName: 'Суд', court: { slug: 'sud-a', name: 'Суд А' }, courtCode: 1, judgeKey: 'k', lastSeen: '2026-11-09', registerDate: '2026-11-09' };
    const html = renderJudge(j, [], [], undefined, { colleagues: judges.slice(0, 5) });
    expect(html).toContain('<h2>Інші судді: Суд А</h2>');
    expect(html).toContain('href="/suddia/j0"');
    expect(html).not.toContain('href="/suddia/j3"');
  });
});
