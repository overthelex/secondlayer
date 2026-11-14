/**
 * A random id kept in this browser, sent with the welcome-bonus card check so
 * a second account from the same browser is held for review. Not a
 * fingerprint: clearing site data resets it.
 */
const KEY = 'lex_device_id';

export function getDeviceId(): string | null {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}
