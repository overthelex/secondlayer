import { violationArticles, complaintArticles, parseCode, CODE_RADA_ID } from '../private-tools/case-checklists.js';

describe('case-checklists', () => {
  it('maps КУпАП to the in-force code and parses spellings', () => {
    expect(CODE_RADA_ID['купап']).toBe('8073-10');
    expect(parseCode('КУпАП')).toBe('купап');
    expect(parseCode(' ЦПК ')).toBe('цпк');
    expect(parseCode('kupap')).toBe('купап');
    expect(parseCode('ПК')).toBeNull();
  });

  it('lists the articles to check for a ruling and an admin-offence record', () => {
    expect(violationArticles('ухвала', 'цпк')).toEqual(['260', '272', '128', '187']);
    expect(violationArticles('протокол', 'купап')).toEqual(['254', '256', '268', '277', '278', '280']);
    expect(violationArticles('постанова', 'купап')).toEqual(['268', '277', '278', '280', '283', '284', '285', '287', '289', '294']);
    expect(violationArticles('вирок', 'кпк')).toEqual(['110', '370', '371', '372', '373', '374']);
    expect(violationArticles('протокол', 'цпк')).toEqual([]);
  });

  it('gives complaint norms with the court fee except КПК and КУпАП, and refuses impossible combinations', () => {
    expect(complaintArticles('цпк', 'апеляційна скарга на рішення')).toEqual({ articles: ['352', '354', '355', '356', '357'], fee: true });
    expect(complaintArticles('кпк', 'касаційна скарга')).toEqual({ articles: ['424', '425', '426', '427'], fee: false });
    expect(complaintArticles('купап', 'скарга на постанову у справі про адмінправопорушення')).toEqual({ articles: ['287', '288', '289', '291', '294', '295'], fee: false });
    expect(complaintArticles('купап', 'касаційна скарга')).toBeNull();
    expect(complaintArticles('цпк', 'скарга на постанову у справі про адмінправопорушення')).toBeNull();
  });
});
