/**
 * Cloudflare Turnstile widget (explicit render). Renders nothing when
 * VITE_TURNSTILE_SITE_KEY is not set, so local dev and tests work without it.
 */
import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __turnstileLoading?: Promise<void>;
  }
}

export const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
export const turnstileEnabled = TURNSTILE_SITE_KEY.length > 0;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!window.__turnstileLoading) {
    window.__turnstileLoading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Turnstile script failed to load'));
      document.head.appendChild(script);
    });
  }
  return window.__turnstileLoading;
}

interface TurnstileWidgetProps {
  /** Receives the token when solved, null when it expires or errors. */
  onToken: (token: string | null) => void;
  action?: string;
  theme?: 'light' | 'dark' | 'auto';
  /** Bump to reset the widget (tokens are single-use). */
  resetKey?: number;
  className?: string;
}

export function TurnstileWidget({ onToken, action, theme = 'dark', resetKey = 0, className }: TurnstileWidgetProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!turnstileEnabled || !hostRef.current) return;
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !hostRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(hostRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          theme,
          size: 'flexible',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        });
      })
      .catch(() => onTokenRef.current(null));

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch { /* already gone */ }
      }
      widgetIdRef.current = null;
    };
  }, [action, theme]);

  useEffect(() => {
    if (resetKey > 0 && widgetIdRef.current && window.turnstile) {
      try { window.turnstile.reset(widgetIdRef.current); } catch { /* ignore */ }
      onTokenRef.current(null);
    }
  }, [resetKey]);

  if (!turnstileEnabled) return null;
  return <div ref={hostRef} className={className} />;
}
