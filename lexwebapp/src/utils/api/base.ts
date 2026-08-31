/**
 * Single source of truth for the API base URL.
 *
 * Three cases, and the middle one is the point of this file:
 *   VITE_API_URL unset      → http://localhost:3000  (dev outside docker)
 *   VITE_API_URL=""         → "" — same origin, the bundle works on any domain
 *   VITE_API_URL="https://…"→ that host, checked against the allow-list
 *
 * The same-origin case is what lets one build serve both legal.org.ua and
 * local.legal.org.ua: nginx fronts the SPA and /api on the same host, so a
 * relative path always lands on the right backend and nothing has to be
 * rebuilt when the domain a deployment answers on changes.
 */

const ALLOWED_API_ORIGINS = [
  'https://legal.org.ua',
  'https://local.legal.org.ua',
  'http://localhost:3000',
  'http://localhost:8080',
];

const raw = import.meta.env.VITE_API_URL as string | undefined;

export const API_BASE = raw === undefined ? 'http://localhost:3000' : raw;

/** true when the bundle talks to whatever host served it */
export const IS_SAME_ORIGIN = API_BASE === '';

if (!IS_SAME_ORIGIN && !ALLOWED_API_ORIGINS.some((o) => API_BASE.startsWith(o))) {
  throw new Error(
    `Invalid VITE_API_URL: "${API_BASE}". Use "" for same-origin, or one of: ${ALLOWED_API_ORIGINS.join(', ')}`
  );
}
