import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Globe, ChevronRight, List, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { useHreflang } from '../hooks/useHreflang';
import { useDocumentMeta } from '../hooks/useDocumentMeta';

interface LegalPageLayoutProps {
  icon: React.ReactNode;
  iconBgClass: string;
  routePath: string;
  contentUk: string;
  contentEn: string;
}

interface TocItem {
  id: string;
  text: string;
  level: number;
}

const LEGAL_PAGES = [
  { path: 'offer', labelUk: 'Публічна оферта', labelEn: 'Public Offer' },
  { path: 'attorney-offer', labelUk: 'Оферта адвоката', labelEn: 'Attorney Offer' },
  { path: 'terms', labelUk: 'Умови використання', labelEn: 'Terms of Use' },
  { path: 'privacy', labelUk: 'Конфіденційність', labelEn: 'Privacy Policy' },
  { path: 'dpa', labelUk: 'Обробка даних', labelEn: 'Data Processing' },
  { path: 'ai-usage', labelUk: 'Використання AI', labelEn: 'AI Usage Policy' },
  { path: 'ai-transparency', labelUk: 'Прозорість AI', labelEn: 'AI Transparency' },
  { path: 'marketplace-rules', labelUk: 'Правила маркетплейсу', labelEn: 'Marketplace Rules' },
  { path: 'refund-policy', labelUk: 'Повернення коштів', labelEn: 'Refund Policy' },
  { path: 'aup', labelUk: 'Допустиме використання', labelEn: 'Acceptable Use Policy' },
  { path: 'api-terms', labelUk: 'Умови використання API', labelEn: 'API Terms of Use' },
];

function extractToc(markdown: string): { toc: TocItem[]; title: string; subtitle: string; meta: string } {
  const lines = markdown.split('\n');
  const toc: TocItem[] = [];
  let title = '';
  let subtitle = '';
  let meta = '';

  for (const line of lines) {
    const h1Match = line.match(/^# (.+)/);
    if (h1Match && !title) {
      title = h1Match[1].trim();
      continue;
    }

    const h2Match = line.match(/^## (.+)/);
    if (h2Match) {
      const text = h2Match[1].trim();
      // First h2 without a number is usually the subtitle
      if (!subtitle && !text.match(/^\d+\./)) {
        subtitle = text;
        continue;
      }
      const id = text
        .toLowerCase()
        .replace(/[^\wа-яіїєґ\s]/gi, '')
        .replace(/\s+/g, '-')
        .substring(0, 60);
      toc.push({ id, text, level: 2 });
    }

    const metaMatch = line.match(/^\*(.+)\*$/);
    if (metaMatch && !meta) {
      meta = metaMatch[1].trim();
    }
  }

  return { toc, title, subtitle, meta };
}

function stripTitleFromContent(markdown: string): string {
  const lines = markdown.split('\n');
  let skipUntilSection = true;
  const result: string[] = [];

  for (const line of lines) {
    if (skipUntilSection) {
      // Skip the title block (H1, first H2 subtitle, meta line, hr)
      if (line.match(/^# /) || line.match(/^---\s*$/) || line.match(/^\*.*\*$/) || line.trim() === '') {
        continue;
      }
      // First H2 that's NOT a numbered section = subtitle, skip it
      if (line.match(/^## /) && !line.match(/^## \d+\./)) {
        continue;
      }
      // Company info block before first numbered section
      if (!line.match(/^## \d+\./) && !line.match(/^#/)) {
        continue;
      }
      skipUntilSection = false;
    }
    result.push(line);
  }

  return result.join('\n');
}

export function LegalPageLayout({
  routePath,
  contentUk,
  contentEn,
}: LegalPageLayoutProps) {
  const { lang } = useParams<{ lang: string }>();
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<string>('');
  const contentRef = useRef<HTMLDivElement>(null);

  const currentLang = lang === 'ua' || lang === 'en' ? lang : 'ua';
  const content = currentLang === 'ua' ? contentUk : contentEn;
  const switchTo = currentLang === 'ua' ? 'en' : 'ua';

  // Only /ua and /en are routed (anything else falls back to ua), and a page
  // without its own English text (e.g. aup) must not advertise an en variant.
  const hasEn = contentEn !== contentUk;
  const hreflangEntries = useMemo(() => [
    { lang: 'uk', href: `https://legal.org.ua/ua/${routePath}` },
    ...(hasEn ? [{ lang: 'en', href: `https://legal.org.ua/en/${routePath}` }] : []),
  ], [routePath, hasEn]);
  useHreflang(hreflangEntries);

  const { toc, title, subtitle, meta } = useMemo(() => extractToc(content), [content]);
  const strippedContent = useMemo(() => stripTitleFromContent(content), [content]);

  const currentPage = LEGAL_PAGES.find(p => p.path === routePath);
  const pageLabel = currentLang === 'ua'
    ? (currentPage?.labelUk || routePath)
    : (currentPage?.labelEn || routePath);

  useDocumentMeta({
    title: `${pageLabel} | LEX`,
    description: currentLang === 'ua'
      ? `${pageLabel} — правовий документ платформи LEX AI. ${subtitle || ''}`
      : `${pageLabel} — legal document for the LEX AI platform. ${subtitle || ''}`,
    ogTitle: `${pageLabel} | LEX`,
    ogDescription: currentLang === 'ua'
      ? `${pageLabel} — правовий документ LEX AI`
      : `${pageLabel} — LEX AI legal document`,
    ogLocale: currentLang === 'ua' ? 'uk_UA' : 'en_US',
    canonical: `https://legal.org.ua/${hasEn ? currentLang : 'ua'}/${routePath}`,
  });

  const [mobileTocOpen, setMobileTocOpen] = useState(false);

  const breadcrumbLabel = pageLabel;

  const scrollToSection = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      const offset = 100;
      const top = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }, []);

  // Track active section on scroll
  useEffect(() => {
    if (toc.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: '-100px 0px -70% 0px', threshold: 0 }
    );

    const timer = setTimeout(() => {
      for (const item of toc) {
        const el = document.getElementById(item.id);
        if (el) observer.observe(el);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [toc]);

  const headingRenderer = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const H2 = (props: any) => {
      const text = String(props.children || '');
      const id = text
        .toLowerCase()
        .replace(/[^\wа-яіїєґ\s]/gi, '')
        .replace(/\s+/g, '-')
        .substring(0, 60);
      return <h2 id={id} className="scroll-mt-28">{props.children}</h2>;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const H3 = (props: any) => {
      const text = String(props.children || '');
      const id = text
        .toLowerCase()
        .replace(/[^\wа-яіїєґ\s]/gi, '')
        .replace(/\s+/g, '-')
        .substring(0, 60);
      return <h3 id={id} className="scroll-mt-28">{props.children}</h3>;
    };
    return { h2: H2, h3: H3 };
  }, []);

  return (
    <div className="min-h-screen bg-claude-bg">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-md border-b border-claude-border sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-4 sm:gap-6">
              <button
                onClick={() => navigate('/')}
                className="flex items-center gap-2 text-claude-subtext hover:text-claude-text transition-colors"
              >
                <ArrowLeft size={16} />
              </button>
              <Link to="/" className="font-serif text-lg font-semibold text-claude-text tracking-tight">
                LEX AI
              </Link>
            </div>

            <div className="flex items-center gap-3">
              {/* Mobile TOC toggle */}
              {toc.length > 0 && (
                <button
                  onClick={() => setMobileTocOpen(!mobileTocOpen)}
                  className="lg:hidden flex items-center gap-1.5 text-sm text-claude-subtext hover:text-claude-text transition-colors"
                  aria-label={currentLang === 'ua' ? 'Зміст' : 'Contents'}
                >
                  {mobileTocOpen ? <X size={18} /> : <List size={18} />}
                </button>
              )}

              <button
                onClick={() => navigate(`/${switchTo}/${routePath}`, { replace: true })}
                className="flex items-center gap-1.5 text-sm text-claude-subtext hover:text-claude-text transition-colors"
              >
                <Globe size={14} />
                <span>{currentLang === 'ua' ? 'EN' : 'UA'}</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Mobile TOC dropdown */}
      {toc.length > 0 && mobileTocOpen && (
        <div className="lg:hidden bg-white border-b border-claude-border shadow-sm sticky top-14 z-10 max-h-[60vh] overflow-y-auto">
          <nav className="px-4 py-4">
            <p className="text-xs font-medium uppercase tracking-widest text-claude-subtext mb-3">
              {currentLang === 'ua' ? 'Зміст' : 'Contents'}
            </p>
            <ul className="space-y-0.5">
              {toc.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => {
                      scrollToSection(item.id);
                      setMobileTocOpen(false);
                    }}
                    className={`block w-full text-left text-sm leading-snug py-2 pl-3 border-l-2 transition-colors ${
                      activeSection === item.id
                        ? 'border-claude-accent text-claude-text font-medium'
                        : 'border-transparent text-claude-subtext hover:text-claude-text'
                    }`}
                  >
                    {item.text}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6">
        <nav className="flex items-center gap-1.5 text-xs sm:text-sm text-claude-subtext">
          <Link to="/" className="hover:text-claude-text transition-colors shrink-0">
            {currentLang === 'ua' ? 'Головна' : 'Home'}
          </Link>
          <ChevronRight size={12} className="shrink-0" />
          <span className="text-claude-text truncate">{breadcrumbLabel}</span>
        </nav>
      </div>

      {/* Hero */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 sm:pt-10 pb-6 sm:pb-8 border-b border-claude-border">
        <div className="max-w-3xl">
          <h1 className="font-serif text-2xl sm:text-4xl md:text-5xl font-semibold text-claude-text leading-tight tracking-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-2 sm:mt-3 text-base sm:text-xl text-claude-subtext font-light">
              {subtitle}
            </p>
          )}
          {meta && (
            <p className="mt-3 sm:mt-4 text-xs sm:text-sm text-claude-subtext">
              {meta}
            </p>
          )}
        </div>
      </div>

      {/* Content with sidebar TOC */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
        <div className="flex gap-12 lg:gap-16">
          {/* Sidebar TOC - desktop only */}
          {toc.length > 0 && (
            <aside className="hidden lg:block w-64 flex-shrink-0">
              <nav className="sticky top-20">
                <p className="text-xs font-medium uppercase tracking-widest text-claude-subtext mb-4">
                  {currentLang === 'ua' ? 'Зміст' : 'Contents'}
                </p>
                <ul className="space-y-1">
                  {toc.map((item) => (
                    <li key={item.id}>
                      <button
                        onClick={() => scrollToSection(item.id)}
                        className={`block w-full text-left text-[13px] leading-snug py-1.5 pl-3 border-l-2 transition-colors ${
                          activeSection === item.id
                            ? 'border-claude-accent text-claude-text font-medium'
                            : 'border-transparent text-claude-subtext hover:text-claude-text hover:border-claude-border'
                        }`}
                      >
                        {item.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            </aside>
          )}

          {/* Main content */}
          <article ref={contentRef} className="flex-1 min-w-0 max-w-3xl">
            <div className="prose prose-lg max-w-none
              prose-headings:font-serif prose-headings:tracking-tight prose-headings:text-claude-text
              prose-h2:text-2xl prose-h2:font-semibold prose-h2:mt-12 prose-h2:mb-4 prose-h2:pt-6 prose-h2:border-t prose-h2:border-claude-border
              prose-h3:text-lg prose-h3:font-semibold prose-h3:mt-6 prose-h3:mb-3
              prose-p:text-claude-text prose-p:leading-relaxed prose-p:text-[15px]
              prose-li:text-claude-text prose-li:text-[15px]
              prose-strong:text-claude-text prose-strong:font-semibold
              prose-em:text-claude-subtext
              prose-hr:border-claude-border prose-hr:my-8
              prose-table:text-sm prose-table:block prose-table:overflow-x-auto
              prose-th:bg-claude-sidebar prose-th:px-4 prose-th:py-2.5 prose-th:text-claude-text prose-th:font-medium
              prose-td:px-4 prose-td:py-2.5 prose-td:border-claude-border
              prose-a:text-claude-text prose-a:underline prose-a:underline-offset-2 prose-a:decoration-claude-accent/40 hover:prose-a:decoration-claude-accent
              prose-a:break-words
              max-sm:[&_h2]:text-xl max-sm:[&_h2]:mt-8 max-sm:[&_h2]:pt-4
              max-sm:[&_h3]:text-base max-sm:[&_h3]:mt-4
              max-sm:[&_p]:text-[14px] max-sm:[&_li]:text-[14px]
              max-sm:[&_th]:px-3 max-sm:[&_th]:py-2 max-sm:[&_th]:whitespace-nowrap max-sm:[&_th]:text-xs
              max-sm:[&_td]:px-3 max-sm:[&_td]:py-2 max-sm:[&_td]:text-xs
            ">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={headingRenderer}
              >
                {strippedContent}
              </ReactMarkdown>
            </div>
          </article>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-claude-border mt-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          {/* Other legal docs */}
          <div className="mb-8">
            <p className="text-xs font-medium uppercase tracking-widest text-claude-subtext mb-4">
              {currentLang === 'ua' ? 'Правові документи' : 'Legal Documents'}
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-2 max-sm:grid max-sm:grid-cols-2">
              {LEGAL_PAGES.filter(p => p.path !== routePath).map((page) => (
                <Link
                  key={page.path}
                  to={`/${currentLang}/${page.path}`}
                  className="text-sm text-claude-subtext hover:text-claude-text transition-colors"
                >
                  {currentLang === 'ua' ? page.labelUk : page.labelEn}
                </Link>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between pt-6 border-t border-claude-border max-sm:flex-col max-sm:items-start max-sm:gap-3">
            <div className="flex items-center gap-3">
              <span className="font-serif text-sm font-semibold text-claude-text">LEX AI</span>
              <span className="text-xs text-claude-subtext">
                &copy; {new Date().getFullYear()} ФОП Кириченко І.В.
              </span>
            </div>
            <div className="flex items-center gap-4">
              <Link
                to="/abuse"
                className="text-sm text-claude-subtext hover:text-claude-text transition-colors"
              >
                {currentLang === 'ua' ? 'Повідомити про порушення' : 'Report Abuse'}
              </Link>
              <a
                href="mailto:info@legal.org.ua"
                className="text-sm text-claude-subtext hover:text-claude-text transition-colors"
              >
                info@legal.org.ua
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
