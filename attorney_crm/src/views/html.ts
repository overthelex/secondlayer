// Template-literal HTML with escaping by default. The result is a branded string
// so nested fragments are not escaped twice; raw() marks trusted markup.

const RAW = Symbol('raw');

export interface RawHtml {
  readonly [RAW]: true;
  readonly value: string;
  toString(): string;
}

export type HtmlValue = string | number | boolean | null | undefined | RawHtml | HtmlValue[];

export function raw(value: string): RawHtml {
  return { [RAW]: true, value, toString: () => value };
}

function isRaw(v: unknown): v is RawHtml {
  return typeof v === 'object' && v !== null && RAW in v;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(v: HtmlValue): string {
  if (v === null || v === undefined || v === false) return '';
  if (isRaw(v)) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): RawHtml {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return raw(out);
}

export function toString(v: RawHtml): string {
  return v.value;
}
