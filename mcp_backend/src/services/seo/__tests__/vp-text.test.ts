import { parseVpText, leadText } from '../vp-text.js';

const TEXT = [
  'П О С Т А Н О В А',
  ' ІМЕНЕМ УКРАЇНИ',
  ' 11 лютого 2026 року',
  ' справа № 754/511/23',
  ' Велика Палата Верховного Суду у складі:',
  ' судді-доповідача Воробйової І. А.,',
  ' УСТАНОВИЛА:',
  ' Вступ',
  ' 1. Між сторонами існував спір про стягнення заборгованості за кредитним договором.',
  ' ІСТОРІЯ СПРАВИ',
  ' 2. Позивач звернувся до суду, просив стягнути 3 % річних;',
  ' ПОЗИЦІЯ ВЕЛИКОЇ ПАЛАТИ ВЕРХОВНОГО СУДУ',
  ' 3. Велика Палата Верховного Суду вважає, що три проценти річних нараховуються на суму боргу.',
  ' Щодо суті вимог і доводів касаційної скарги',
  ' П О С Т А Н О В И Л А:',
  ' Касаційну скаргу задовольнити.',
].join('\n\n');

describe('parseVpText', () => {
  const doc = parseVpText(TEXT);

  it('splits off the header without the form title', () => {
    expect(doc.header).toEqual(['11 лютого 2026 року', 'справа № 754/511/23', 'Велика Палата Верховного Суду у складі:', 'судді-доповідача Воробйової І. А.,']);
  });

  it('finds section headings, the Grand Chamber position and the operative part', () => {
    const heads = doc.blocks.filter(b => b.kind === 'heading').map(b => b.text);
    expect(heads).toEqual(['Установила', 'Вступ', 'ІСТОРІЯ СПРАВИ', 'ПОЗИЦІЯ ВЕЛИКОЇ ПАЛАТИ ВЕРХОВНОГО СУДУ', 'Щодо суті вимог і доводів касаційної скарги', 'Постановила']);
    expect(doc.blocks[doc.reasoningAt!]).toMatchObject({ id: 'pozytsiia' });
    expect(doc.blocks[doc.resolutiveAt!]).toMatchObject({ id: 'postanovyla' });
    expect(doc.blocks[doc.resolutiveAt! + 1]).toEqual({ kind: 'para', text: 'Касаційну скаргу задовольнити.' });
  });

  it('keeps every body line verbatim', () => {
    const paras = doc.blocks.filter(b => b.kind === 'para').map(b => b.text);
    expect(paras).toContain('2. Позивач звернувся до суду, просив стягнути 3 % річних;');
  });

  it('takes the lead from «Вступ», else from the position', () => {
    expect(leadText(doc)).toBe('Між сторонами існував спір про стягнення заборгованості за кредитним договором.');
    const noIntro = parseVpText(TEXT.replace(' Вступ\n\n', ''));
    expect(leadText(noIntro)).toBe('Велика Палата Верховного Суду вважає, що три проценти річних нараховуються на суму боргу.');
  });

  it('does not treat a long sentence as a heading', () => {
    const d = parseVpText('Щодо застосування статті 625 ЦК України суди дійшли висновку, що позов задоволено правильно, а доводи скарги необґрунтовані.');
    expect(d.blocks[0].kind).toBe('para');
  });
});
