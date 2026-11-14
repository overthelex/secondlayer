import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Users } from 'lucide-react';
import { useDocumentMeta } from '../../hooks/useDocumentMeta';
import { useLocaleStore } from '../../stores/localeStore';
import { getAboutCopy } from './copy';
import { LangToggle } from './LangToggle';
import { PublicNavLinks } from '../../components/PublicNavLinks';

export function AboutPage() {
  const navigate = useNavigate();
  const language = useLocaleStore((s) => s.language);
  const c = getAboutCopy(language);

  useDocumentMeta({
    title: c.metaTitle,
    description: c.metaDescription,
    ogTitle: c.metaTitle,
    ogDescription: c.metaDescription,
  });


  return (
    <div className="min-h-screen bg-gradient-to-br from-claude-bg via-white to-claude-sidebar">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-claude-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => navigate('/login')}
            className="flex items-center gap-2 text-claude-subtext hover:text-claude-text transition-colors font-sans text-sm"
          >
            <ArrowLeft size={16} />
            {c.back}
          </button>
          <PublicNavLinks className="flex-1 justify-center" />
          <div className="flex-1 md:hidden" />
          <LangToggle />
          <img src="/Image.jpg" alt="LEX" className="h-9 w-auto" />
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <p className="text-xs font-sans uppercase tracking-[0.18em] text-claude-accent mb-4">
            {c.hero.kicker}
          </p>
          <h1 className="text-3xl sm:text-5xl font-serif text-claude-text font-medium leading-tight mb-6">
            {c.hero.headline}
          </h1>
          <p className="text-base sm:text-lg text-claude-subtext font-sans leading-relaxed">
            {c.hero.lead}
          </p>
        </motion.div>

        {/* Stat band */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.15 }}
          className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-3"
        >
          {[
            { v: '120M+', l: language === 'uk' ? 'судових рішень' : 'court decisions' },
            { v: '41M+', l: language === 'uk' ? 'записів реєстрів' : 'registry records' },
            { v: '118', l: language === 'uk' ? 'AI-інструментів' : 'AI tools' },
            { v: '12k+', l: language === 'uk' ? 'профілів суддів' : 'judge profiles' },
          ].map((s) => (
            <div
              key={s.l}
              className="rounded-xl bg-white border border-claude-border p-4 text-center"
            >
              <div className="text-2xl font-serif text-claude-text font-medium">{s.v}</div>
              <div className="text-xs font-sans text-claude-subtext mt-1">{s.l}</div>
            </div>
          ))}
        </motion.div>

        {/* Sections */}
        <Section title={c.problem.title} body={c.problem.body} />

        {/* Audience grid */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mt-14"
        >
          <h2 className="text-2xl font-serif text-claude-text font-medium mb-6">
            {c.audience.title}
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {c.audience.items.map((it) => (
              <div
                key={it.title}
                className="rounded-xl bg-white border border-claude-border p-5"
              >
                <h3 className="text-sm font-sans font-semibold text-claude-text mb-1.5">
                  {it.title}
                </h3>
                <p className="text-sm text-claude-subtext font-sans leading-relaxed">
                  {it.body}
                </p>
              </div>
            ))}
          </div>
        </motion.section>

        <Section title={c.market.title} body={c.market.body} />
        <Section title={c.differentiation.title} body={c.differentiation.body} />
        <Section title={c.geography.title} body={c.geography.body} />

        <section className="mt-14">
          <h2 className="text-2xl font-serif text-claude-text font-medium mb-3">{c.legal.title}</h2>
          <p className="text-base text-claude-subtext font-sans leading-relaxed">{c.legal.intro}</p>
          <address className="not-italic mt-2 text-base text-claude-subtext font-sans leading-relaxed">
            {c.legal.lines.map((l) => (
              <div key={l}>{l}</div>
            ))}
          </address>
          <p className="mt-2 text-sm font-sans text-claude-subtext">
            <a className="underline" href={language === 'uk' ? '/ua/offer' : '/en/offer'}>{language === 'uk' ? 'Публічна оферта' : 'Public offer'}</a>
            {' · '}
            <a className="underline" href="/pricing">{language === 'uk' ? 'Ціни' : 'Pricing'}</a>
          </p>
        </section>

        {/* CTA */}
        <div className="mt-16 rounded-2xl bg-white border border-claude-border p-8 flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
          <div>
            <p className="text-xs font-sans uppercase tracking-wider text-claude-subtext mb-1">
              SecondLayer · legal.org.ua
            </p>
            <p className="text-base font-serif text-claude-text">
              {language === 'uk'
                ? 'Готові побачити продукт у дії?'
                : 'Ready to see the product?'}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => navigate('/about/team')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-claude-border text-claude-text font-sans text-sm font-medium hover:border-claude-accent/40 transition-colors"
            >
              <Users size={16} />
              {c.ctaTeam}
            </button>
            <button
              onClick={() => navigate('/product')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-claude-accent text-white font-sans text-sm font-medium hover:bg-claude-accent/90 transition-colors"
            >
              {c.ctaTry}
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="mt-14"
    >
      <h2 className="text-2xl font-serif text-claude-text font-medium mb-3">{title}</h2>
      <p className="text-base text-claude-subtext font-sans leading-relaxed">{body}</p>
    </motion.section>
  );
}
