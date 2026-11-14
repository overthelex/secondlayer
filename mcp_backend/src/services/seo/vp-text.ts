/**
 * Splits the plain ЄДРСР text of a Supreme Court постанова into blocks for
 * display: the header (court, composition, parties' representatives), section
 * headings, paragraphs, and the resolutive part after «ПОСТАНОВИЛА:».
 * Deterministic and text-only: nothing is paraphrased or generated.
 */

export type VpBlock =
  | { kind: 'heading'; text: string; id?: 'pozytsiia' | 'postanovyla' }
  | { kind: 'para'; text: string };

export interface VpDoc {
  header: string[];
  blocks: VpBlock[];
  /** Index in blocks of the first heading of the court's own reasoning, if found. */
  reasoningAt: number | null;
  /** Index in blocks of the «ПОСТАНОВИЛА:» heading, if found. */
  resolutiveAt: number | null;
}

const OPERATIVE = /^п\s*о\s*с\s*т\s*а\s*н\s*о\s*в\s*и\s*л\s*[аи]\s*:?$/iu;
const ESTABLISHED = /^(?:у|в)\s*с\s*т\s*а\s*н\s*о\s*в\s*и\s*л\s*[аи]\s*:?$/iu;
const TITLE = /^(?:(?:додаткова\s+)?п\s*о\s*с\s*т\s*а\s*н\s*о\s*в\s*а|і\s*м\s*е\s*н\s*е\s*м\s+у\s*к\s*р\s*а\s*ї\s*н\s*и)$/iu;
const NAMED_HEADING = /^(?:\d+(?:\.\d+)*\.?\s*)?(?:вступ|історія справи|короткий зміст|стислий виклад|позиція|висновки?|оцінка|аргументи|доводи|рух справи|обставини|релевантні|мотиви|щодо|судові витрати|джерела права|фактичні обставини|встановлені)(?!\p{L})/iu;
const REASONING = /^(?:\d+(?:\.\d+)*\.?\s*)?(?:позиція|оцінка|висновки?|мотиви)(?!\p{L}).*(?:велик\S* палат|верховн\S* суд|колегі|суд\S* касаційн)/iu;

function capsRatio(s: string): number {
  const letters = s.match(/\p{L}/gu) || [];
  if (letters.length < 4) return 0;
  return letters.filter(ch => ch === ch.toUpperCase() && ch !== ch.toLowerCase()).length / letters.length;
}

function isHeading(line: string): boolean {
  if (line.length > 160 || /[,;]$/.test(line)) return false;
  if (OPERATIVE.test(line) || ESTABLISHED.test(line)) return true;
  if (capsRatio(line) > 0.8) return true;
  // a named heading is a short line that is not a full sentence
  return NAMED_HEADING.test(line) && line.length <= 120 && !/\.\s*$/.test(line.replace(/^\d+(?:\.\d+)*\.\s*/, ''));
}

export function parseVpText(fullText: string): VpDoc {
  const lines = fullText.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // Header = everything before «УСТАНОВИЛА:», or else before the first section
  // heading; the form title and «ІМЕНЕМ УКРАЇНИ» are dropped (the page has its own h1).
  let est = lines.findIndex(l => ESTABLISHED.test(l));
  if (est < 0 || est >= 40) {
    est = lines.findIndex((l, i) => i > 0 && isHeading(l) && !TITLE.test(l));
    if (est >= 40) est = -1;
  }
  const header = (est > 0 ? lines.slice(0, est) : []).filter(l => !TITLE.test(l));
  const body = (est > 0 ? lines.slice(est) : lines).filter(l => !TITLE.test(l));

  const blocks: VpBlock[] = [];
  let reasoningAt: number | null = null;
  let resolutiveAt: number | null = null;
  for (const line of body) {
    if (isHeading(line)) {
      if (OPERATIVE.test(line) && resolutiveAt === null) {
        resolutiveAt = blocks.length;
        blocks.push({ kind: 'heading', text: 'Постановила', id: 'postanovyla' });
        continue;
      }
      if (reasoningAt === null && REASONING.test(line)) {
        reasoningAt = blocks.length;
        blocks.push({ kind: 'heading', text: line, id: 'pozytsiia' });
        continue;
      }
      blocks.push({ kind: 'heading', text: ESTABLISHED.test(line) ? 'Установила' : line });
    } else {
      blocks.push({ kind: 'para', text: line });
    }
  }
  return { header, blocks, reasoningAt, resolutiveAt };
}

/** First paragraphs of the court's reasoning (or of the body), for meta descriptions. */
export function leadText(doc: VpDoc, max = 220): string {
  // «Вступ» (newer Grand Chamber rulings) states the question decided; else the reasoning.
  const intro = doc.blocks.findIndex(b => b.kind === 'heading' && /^вступ$/iu.test(b.text));
  const from = intro >= 0 ? intro + 1 : doc.reasoningAt !== null ? doc.reasoningAt + 1 : 0;
  const p = doc.blocks.slice(from).find(b => b.kind === 'para' && b.text.length > 60 && /[.;:…»)]$/.test(b.text));
  const t = p ? p.text.replace(/^\d+(?:\.\d+)*\.\s*/, '') : '';
  return t.length <= max ? t : t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}
