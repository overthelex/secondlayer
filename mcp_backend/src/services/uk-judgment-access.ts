/**
 * Who may reach the UK judgment corpus.
 *
 * The Find Case Law licence application (TNA ref CAS-349914-B9P5B8) answers
 * question 13 "Restricted access — only subscribers or research peers" and
 * question 14 "legal professionals and researchers". That answer is what buys the
 * 5-year transactional licence instead of a 1-year R&D licence whose outputs
 * cannot be given to third parties.
 *
 * It was not true when it was written: any authenticated user could mint an API
 * key and read judgments through `search_registry`. This module makes it true.
 *
 * ⚠ Judgments only. The uk_legislation* registries are Open Government Licence
 * v3.0 with commercial use permitted, so gating them would be a restriction we
 * invented rather than one we were given.
 */

import { logger } from '../utils/logger.js';

/**
 * Registries whose rows are Find Case Law records. Adding a registry here is the
 * only thing needed to bring it under the licence gate.
 */
export const LICENCE_GATED_REGISTRIES = new Set<string>(['uk_court_decisions']);

/** Free-mail hosts. A signal that routes an application to review — never a refusal:
 *  a sole practitioner or a barrister on a personal address is ordinary. */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'proton.me',
  'protonmail.com', 'gmx.com', 'mail.ru', 'ukr.net', 'yandex.ru',
]);

export function isFreeMailDomain(email: string | undefined | null): boolean {
  const d = (email || '').split('@')[1]?.toLowerCase();
  return d ? FREE_MAIL.has(d) : false;
}

export function emailDomain(email: string | undefined | null): string | null {
  return (email || '').split('@')[1]?.toLowerCase() || null;
}

/**
 * The registry a tool call is asking for, when that registry is licence-gated.
 * Returns null for everything else, so the guard costs one Set lookup on the
 * overwhelming majority of calls.
 */
export function gatedRegistryOf(toolName: string, args: any): string | null {
  if (toolName !== 'search_registry') return null;
  const registry = args?.registry;
  return typeof registry === 'string' && LICENCE_GATED_REGISTRIES.has(registry)
    ? registry
    : null;
}

export interface AccessDecision {
  allowed: boolean;
  /** User-facing, in the language of the licence rather than of the database. */
  message?: string;
}

const DENIED_NO_RECORD: AccessDecision = {
  allowed: false,
  message:
    'Доступ до корпусу судових рішень Великої Британії (Find Case Law) надається ' +
    'лише практикуючим юристам, юридичним департаментам та дослідникам. ' +
    'Це умова ліцензії The National Archives, а не наше обмеження: сервіс не ' +
    'пропонується широкому загалу та особам, які ведуть власну справу без адвоката. ' +
    'Щоб отримати доступ, подайте заяву через /api/uk-judgments/access із зазначенням ' +
    'організації та ролі. Законодавство Великої Британії доступне без цієї умови.',
};

const DENIED_PENDING: AccessDecision = {
  allowed: false,
  message:
    'Вашу заяву на доступ до корпусу судових рішень Великої Британії отримано і ще ' +
    'не розглянуто. Ми повідомимо, щойно буде рішення.',
};

const DENIED_REFUSED: AccessDecision = {
  allowed: false,
  message:
    'Доступ до корпусу судових рішень Великої Британії для цього облікового запису ' +
    'закрито. Якщо це помилка, напишіть нам.',
};

/**
 * Decide whether this user may read judgments.
 *
 * Fails CLOSED. A database error here denies access rather than allowing it: a
 * licence commitment is exactly the place where a fallback that "keeps working"
 * quietly breaks the promise it was meant to keep.
 */
export async function checkJudgmentAccess(
  db: any,
  // JWT and OAuth hand back a string id, the HTTP layer a number. Accept both here
  // rather than casting at four call sites and getting one of them wrong.
  userId: string | number | undefined | null
): Promise<AccessDecision> {
  if (userId === undefined || userId === null || userId === '') return DENIED_NO_RECORD;
  try {
    const r = await db.query(
      'SELECT status FROM uk_judgment_access WHERE user_id = $1',
      [userId]
    );
    const status = r.rows[0]?.status;
    if (status === 'granted') return { allowed: true };
    if (status === 'pending') return DENIED_PENDING;
    if (status === 'refused' || status === 'revoked') return DENIED_REFUSED;
    return DENIED_NO_RECORD;
  } catch (error: any) {
    logger.error('uk judgment access check failed — denying', {
      userId,
      error: error.message,
    });
    return DENIED_REFUSED;
  }
}

/**
 * Principle 6 of the licence: access is logged. Best-effort — a failure to write
 * the log must not deny a user who is entitled to the data, which is the opposite
 * of the rule for the check above.
 */
export async function logJudgmentAccess(
  db: any,
  userId: string | number | undefined | null,
  registry: string,
  filters: any,
  rowsReturned?: number
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO uk_judgment_access_log (user_id, registry, filters, rows_returned)
       VALUES ($1, $2, $3, $4)`,
      [userId ?? null, registry, filters ? JSON.stringify(filters) : null,
       rowsReturned ?? null]
    );
  } catch (error: any) {
    logger.warn('uk judgment access log write failed', { error: error.message });
  }
}
