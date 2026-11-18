import { Readable } from 'stream';
// sax has no type declarations in this package.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sax = require('sax');
import { forbiddenCharRefFilter, replaceForbiddenCharRefs } from '../xml-char-refs';

async function collect(chunks: string[]): Promise<string> {
  let out = '';
  const s = Readable.from(chunks).pipe(forbiddenCharRefFilter());
  for await (const c of s) out += c;
  return out;
}

describe('forbidden XML character references', () => {
  it('replaces C0 controls and keeps legal references', () => {
    expect(replaceForbiddenCharRefs('a&#14;b&#24;c&#x1F;d')).toBe('a b c d');
    expect(replaceForbiddenCharRefs('&#9;&#10;&#13;&#1031;&apos;&quot;&amp;&#x41;')).toBe('&#9;&#10;&#13;&#1031;&apos;&quot;&amp;&#x41;');
  });

  it('handles a reference split across chunks', async () => {
    expect(await collect(['<n>ФОП&#', '14;Ї&#x', '1', '8;</n>'])).toBe('<n>ФОП Ї </n>');
    expect(await collect(['a &am', 'p; b &#10', '31;'])).toBe('a &amp; b &#1031;');
    expect(await collect(['tail &#'])).toBe('tail &#');
  });

  it('gives strict sax text without the control references', async () => {
    const xml = '<DATA><SUBJECT><NAME>ІВАН&#14;ОВ &apos;Т&apos;</NAME></SUBJECT></DATA>';
    // sax >= 1.6.1 (the deployed image) rejects &#14; / &#24; in strict mode; 1.6.0 lets them through,
    // so only the filtered result is asserted here.
    const fixed = await collect([xml.slice(0, 22), xml.slice(22)]);
    let text = '';
    const p = sax.parser(true);
    p.ontext = (t: string) => { text += t; };
    p.write(fixed).close();
    expect(text).toBe("ІВАН ОВ 'Т'");
  });
});
