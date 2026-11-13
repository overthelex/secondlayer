import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, ShieldCheck } from 'lucide-react';
import { useDocumentMeta } from '../../hooks/useDocumentMeta';
import { useLocaleStore } from '../../stores/localeStore';
import { LangToggle } from '../AboutPage/LangToggle';
import { getProductCopy } from './copy';

export function ProductPage() {
  const navigate = useNavigate();
  const language = useLocaleStore((s) => s.language);
  const c = getProductCopy(language);

  useDocumentMeta({
    title: c.metaTitle,
    description: c.metaDescription,
    ogTitle: c.metaTitle,
    ogDescription: c.metaDescription,
    ogImage: 'https://legal.org.ua/product-screenshots/01-hero-workflow-plan.png',
  });


  return (
    <div className="min-h-screen bg-gradient-to-br from-claude-bg via-white to-claude-sidebar">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-claude-border">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => navigate('/login')}
            className="flex items-center gap-2 text-claude-subtext hover:text-claude-text transition-colors font-sans text-sm"
          >
            <ArrowLeft size={16} />
            {c.back}
          </button>
          <div className="flex-1" />
          <LangToggle />
          <img src="/Image.jpg" alt="LEX" className="h-9 w-auto" />
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="max-w-3xl mb-14"
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

        {/* Hero screenshot — pull from product 01 */}
        {c.products[0]?.screenshots[0] && (
          <motion.figure
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="rounded-2xl overflow-hidden border border-claude-border bg-white shadow-elevation-1 mb-20"
          >
            <img
              src={c.products[0].screenshots[0].src}
              alt={c.products[0].screenshots[0].caption}
              className="w-full h-auto block"
              loading="eager"
            />
            <figcaption className="px-5 py-3 text-xs font-sans text-claude-subtext border-t border-claude-border">
              {c.products[0].screenshots[0].caption}
            </figcaption>
          </motion.figure>
        )}

        {/* Products */}
        <div className="space-y-24">
          {c.products.map((p, idx) => (
            <ProductSection
              key={p.slug}
              p={p}
              stageLabel={p.stage === 'live' ? c.stage.live : c.stage.beta}
              skipFirstShot={idx === 0}
            />
          ))}
        </div>

        {/* Security */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mt-24 rounded-2xl bg-white border border-claude-border p-8 sm:p-10"
        >
          <div className="flex items-start gap-4 mb-6">
            <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-claude-accent/10 text-claude-accent flex items-center justify-center">
              <ShieldCheck size={22} />
            </div>
            <div>
              <h2 className="text-2xl font-serif text-claude-text font-medium">
                {c.security.title}
              </h2>
              <p className="text-sm text-claude-subtext font-sans mt-2 max-w-2xl">
                {c.security.body}
              </p>
            </div>
          </div>
          <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-3 mt-6">
            {c.security.items.map((it) => (
              <li
                key={it}
                className="flex gap-2.5 text-sm font-sans text-claude-text leading-relaxed"
              >
                <Check size={16} className="flex-shrink-0 text-claude-accent mt-0.5" />
                <span>{it}</span>
              </li>
            ))}
          </ul>
          {/* Diia screenshot */}
          <figure className="mt-8 rounded-xl overflow-hidden border border-claude-border">
            <img
              src="/product-screenshots/13-diia-auth.png"
              alt="Diia.Підпис auth"
              className="w-full h-auto block"
              loading="lazy"
            />
            <figcaption className="px-4 py-2.5 text-xs font-sans text-claude-subtext border-t border-claude-border bg-claude-bg/50">
              {language === 'uk'
                ? 'Авторизація через Дія.Підпис — національна цифрова ідентифікація'
                : 'Auth via Diia.Підпис — Ukraine\'s national digital identity'}
            </figcaption>
          </figure>
          {/* E2EE Vault screenshots */}
          <div className="grid sm:grid-cols-2 gap-4 mt-4">
            <figure className="rounded-xl overflow-hidden border border-claude-border">
              <img
                src="/product-screenshots/11-vault-encrypted.png"
                alt="Encrypted vault"
                className="w-full h-auto block"
                loading="lazy"
              />
            </figure>
            <figure className="rounded-xl overflow-hidden border border-claude-border">
              <img
                src="/product-screenshots/12-vault-unlock-modal.png"
                alt="Vault unlock"
                className="w-full h-auto block"
                loading="lazy"
              />
            </figure>
          </div>
        </motion.section>

        {/* Infra */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mt-12"
        >
          <h2 className="text-2xl font-serif text-claude-text font-medium mb-6">
            {c.infra.title}
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {c.infra.items.map((it) => (
              <div
                key={it.label}
                className="rounded-xl bg-white border border-claude-border p-5"
              >
                <p className="text-xs uppercase tracking-wider text-claude-subtext font-sans font-semibold mb-1.5">
                  {it.label}
                </p>
                <p className="text-sm text-claude-text font-sans leading-relaxed">
                  {it.value}
                </p>
              </div>
            ))}
          </div>
        </motion.section>

        {/* Pricing */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mt-12 rounded-2xl bg-white border border-claude-border p-8"
        >
          <h2 className="text-2xl font-serif text-claude-text font-medium mb-6">
            {c.pricing.title}
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {c.pricing.plans.map((p) => (
              <div
                key={p.name}
                className="rounded-xl border border-claude-border bg-claude-bg/40 p-5"
              >
                <p className="text-xs uppercase tracking-wider text-claude-subtext font-sans font-semibold mb-2">
                  {p.name}
                </p>
                <p className="text-base font-serif text-claude-text">{p.price}</p>
              </div>
            ))}
          </div>
          <p className="text-sm font-sans text-claude-subtext mt-5">{c.pricing.note}</p>
        </motion.section>

        {/* CTA */}
        <div className="mt-16 rounded-2xl bg-claude-text text-white p-8 sm:p-10 flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
          <div>
            <p className="text-2xl font-serif font-medium">{c.cta.title}</p>
            <p className="text-sm font-sans text-white/70 mt-1">{c.cta.subtitle}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a
              href="mailto:info@legal.org.ua"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-sans text-sm font-medium transition-colors"
            >
              {c.cta.secondary}
            </a>
            <a
              href="https://legal.org.ua"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-claude-accent hover:bg-claude-accent/90 text-white font-sans text-sm font-medium transition-colors"
            >
              {c.cta.primary}
              <ArrowRight size={16} />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SectionProps {
  p: ReturnType<typeof getProductCopy>['products'][number];
  stageLabel: string;
  skipFirstShot: boolean;
}

function ProductSection({ p, stageLabel, skipFirstShot }: SectionProps) {
  const shots = skipFirstShot ? p.screenshots.slice(1) : p.screenshots;

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="grid lg:grid-cols-[260px_1fr] gap-8"
    >
      <div className="lg:sticky lg:top-24 self-start">
        <p className="text-5xl font-serif text-claude-accent/30 leading-none mb-3">
          {p.number}
        </p>
        <h2 className="text-2xl font-serif text-claude-text font-medium mb-2">
          {p.title}
        </h2>
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-sans font-semibold uppercase tracking-wider ${
            p.stage === 'live'
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : 'bg-amber-50 text-amber-700 border border-amber-200'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${p.stage === 'live' ? 'bg-emerald-500' : 'bg-amber-500'}`}
          />
          {stageLabel}
        </span>
      </div>

      <div>
        <p className="text-base text-claude-text font-sans leading-relaxed mb-5">
          {p.summary}
        </p>
        <ul className="space-y-2.5 mb-8">
          {p.features.map((f) => (
            <li
              key={f}
              className="flex gap-2.5 text-sm font-sans text-claude-subtext leading-relaxed"
            >
              <Check size={16} className="flex-shrink-0 text-claude-accent mt-0.5" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
        {shots.length > 0 && (
          <div className="grid sm:grid-cols-2 gap-4">
            {shots.map((s) => (
              <figure
                key={s.src}
                className="rounded-xl overflow-hidden border border-claude-border bg-white"
              >
                <img src={s.src} alt={s.caption} className="w-full h-auto block" loading="lazy" />
                <figcaption className="px-4 py-2.5 text-xs font-sans text-claude-subtext border-t border-claude-border bg-claude-bg/50">
                  {s.caption}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </motion.section>
  );
}
