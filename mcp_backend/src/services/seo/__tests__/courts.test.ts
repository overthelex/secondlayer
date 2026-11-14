import { subjectOrNull, presidingJudge, shortName } from '../courts-repository.js';
import { hearingsHtml } from '../courts-render.js';
import { translit, slugify } from '../translit.js';
import { statsTable, kindShares, isActive, renderCourt, renderJudge } from '../courts-render.js';
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
