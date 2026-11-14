/**
 * Links to the public server-rendered sections, the same set as the SSR page
 * header (mcp_backend/src/services/seo/seo-page.ts). Plain <a>: these paths are
 * served by the backend, not by the SPA router. Hidden on narrow screens.
 */
import { useLocaleStore } from '../stores/localeStore';

const LINKS: Array<{ href: string; uk: string; en: string }> = [
  { href: '/zakon', uk: 'Кодекси', en: 'Codes' },
  { href: '/sud', uk: 'Суди', en: 'Courts' },
  { href: '/pozytsiia-vs', uk: 'Практика ВП', en: 'Supreme Court' },
  { href: '/kalkuliator-sudovoho-zboru', uk: 'Калькулятор збору', en: 'Court fee calculator' },
  { href: '/praktykum', uk: 'Практикум', en: 'Practicum' },
  { href: '/pricing', uk: 'Ціни', en: 'Pricing' },
  { href: '/blog/uk', uk: 'Блог', en: 'Blog' },
];

export function PublicNavLinks({ className = '' }: { className?: string }) {
  const language = useLocaleStore((s) => s.language);
  const en = language === 'en';
  return (
    <nav aria-label={en ? 'Sections' : 'Розділи'} className={`hidden md:flex items-center gap-4 font-sans text-sm ${className}`}>
      {LINKS.map((l) => (
        <a key={l.href} href={l.href} className="text-claude-subtext hover:text-claude-text transition-colors whitespace-nowrap">
          {en ? l.en : l.uk}
        </a>
      ))}
    </nav>
  );
}
