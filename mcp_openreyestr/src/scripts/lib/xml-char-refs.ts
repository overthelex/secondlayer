import { Transform, TransformCallback } from 'stream';

/**
 * Character references to code points XML 1.0 forbids (C0 controls other than
 * tab/LF/CR, surrogates, U+FFFE/U+FFFF). The ЄДР FOP.xml (data.gov.ua, 11.2026)
 * carries a few, e.g. "&#14;" and "&#24;", and sax in strict mode stops the whole
 * 2M-record import on the first one with "Invalid character entity".
 */
const CHAR_REF = /&#(x[0-9a-fA-F]+|[0-9]+);/g;

export function isForbiddenXmlCodePoint(cp: number): boolean {
  if (cp < 0x20) return cp !== 0x09 && cp !== 0x0a && cp !== 0x0d;
  if (cp >= 0xd800 && cp <= 0xdfff) return true;
  if (cp === 0xfffe || cp === 0xffff) return true;
  return cp > 0x10ffff;
}

/** Replace forbidden character references with a space; leave every other reference alone. */
export function replaceForbiddenCharRefs(text: string): string {
  return text.replace(CHAR_REF, (ref, body: string) => {
    const cp = body[0] === 'x' ? parseInt(body.slice(1), 16) : parseInt(body, 10);
    return isForbiddenXmlCodePoint(cp) ? ' ' : ref;
  });
}

// Longest reference we may need to hold back across a chunk boundary: "&#x10FFFF;".
const MAX_REF_LEN = 10;

/**
 * Text stream transform applying replaceForbiddenCharRefs. A reference split
 * between two chunks is held back until the next chunk completes it.
 */
export function forbiddenCharRefFilter(): Transform {
  let carry = '';
  return new Transform({
    decodeStrings: false,
    encoding: 'utf8',
    transform(chunk: string | Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      let text = carry + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      carry = '';
      const amp = text.lastIndexOf('&', text.length - 1);
      if (amp !== -1 && text.length - amp < MAX_REF_LEN && text.indexOf(';', amp) === -1) {
        carry = text.slice(amp);
        text = text.slice(0, amp);
      }
      cb(null, replaceForbiddenCharRefs(text));
    },
    flush(cb: TransformCallback) {
      cb(null, carry ? replaceForbiddenCharRefs(carry) : '');
    },
  });
}
