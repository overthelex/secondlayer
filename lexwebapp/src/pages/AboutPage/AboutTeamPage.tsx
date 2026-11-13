import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Linkedin, Mail, Phone, Github } from 'lucide-react';
import { useDocumentMeta } from '../../hooks/useDocumentMeta';
import { useLocaleStore } from '../../stores/localeStore';
import { LangToggle } from './LangToggle';

interface Founder {
  slug: string;
  name: string;
  role: string;
  photo: string;
  bio: string;
  expertise: string;
  education?: string;
  linkedin: string;
  email: string;
  phone?: string;
  github?: string;
  huggingface?: string;
}

interface TeamCopy {
  metaTitle: string;
  metaDescription: string;
  back: string;
  hero: { kicker: string; headline: string; lead: string };
  founders: Founder[];
  expertiseLabel: string;
  educationLabel: string;
  wider: { title: string; body: string };
}

const en: TeamCopy = {
  metaTitle: 'Team — LEX | Founders & Engineering',
  metaDescription:
    'The team behind LEX: Volodymyr Ovcharov (CEO & AI Researcher, 25+ years in CS) and Igor Kyrychenko (COO & CLO, PhD in Law).',
  back: 'Back',
  hero: {
    kicker: 'Founders',
    headline: 'The team behind LEX.',
    lead:
      'A Ukrainian-founded company combining 25+ years of computer science and AI research with deep Ukrainian legal-domain expertise. The platform is built end-to-end in-house: data-ingestion pipelines, AI orchestration, frontend, and infrastructure.',
  },
  founders: [
    {
      slug: 'volodymyr',
      name: 'Volodymyr Ovcharov',
      role: 'Co-founder, CEO & AI Researcher',
      photo: '/team/volodymyr.jpg',
      bio:
        '25+ years in computer science and software engineering. Built LEX AI – an AI-powered legal intelligence platform processing 100M+ court decisions across 12 jurisdictions. Prior: 2x CTO in Seoul (30-person team, OCaml/Haskell/Polkadot), startup exit (AVOX, VoIP – Startup Sauna 2016 winner, acquired), Toptal (top 3%). Currently training domain-specific legal LLM on 8xH100 (NVIDIA Innovation Lab). 14 research papers (93% sole-authored), 14 open datasets on HuggingFace.',
      expertise:
        'LLM training at scale (CPT, SFT, DPO on H100/A10G clusters); legal NLP for morphologically rich languages; RAG architecture and semantic search (500M+ document corpus); research – 3 arXiv publications in cs.CL/cs.IR, 6 manuscripts ready; open-data engineering – 14 HuggingFace datasets including the largest non-English legal NLP corpus; distributed systems architecture (TypeScript, PostgreSQL, Qdrant, Redis, AWS); startup leadership and prior exit.',
      education:
        'MSc Computational Science, Igor Sikorsky Kyiv Polytechnic Institute (KPI). PhD candidate (Computer Science, specialty 122), V.M. Glushkov Institute of Cybernetics, National Academy of Sciences of Ukraine. Dissertation: 5/6 chapters completed.',
      linkedin: 'https://linkedin.com/in/volodymir-ovcharov',
      email: 'volodymyr@legal.org.ua',
      github: 'https://github.com/overthelex',
      huggingface: 'https://huggingface.co/overthelex',
    },
    {
      slug: 'igor',
      name: 'Igor Kyrychenko',
      role: 'Co-founder, COO & CLO',
      photo: '/team/igor.jpg',
      bio:
        'PhD in Law, with deep expertise in Ukrainian and international legal practice. Director of the operating Ukrainian entity (LLC). Responsible for product direction, legal-domain modelling (the taxonomy of 118 MCP tools, the workflow templates for litigation, and the doctrinal weighting used in retrieval), business development, and partnerships with law firms, bar associations, and the government sector.',
      expertise:
        'Ukrainian civil, commercial, and criminal procedure; Supreme Court doctrinal analysis; legal-domain ontology design; legal-tech go-to-market in Ukraine; partnerships with the Ukrainian Bar Association and Diia (Ministry of Digital Transformation).',
      linkedin: 'https://www.linkedin.com/in/ihor-kyrychenko-90503890/',
      email: 'igor@legal.org.ua',
      phone: '+380 67 720 63 53',
    },
  ],
  expertiseLabel: 'Selected expertise',
  educationLabel: 'Education',
  wider: {
    title: 'The wider team',
    body:
      'In-house engineers and contributors across backend (TypeScript / Node.js), frontend (React 19), data engineering (PostgreSQL, Qdrant, Redis), DevOps (AWS, Docker, blue-green CI/CD), and legal review by practising Ukrainian lawyers. We actively collaborate with independent open-source contributors.',
  },
};

const uk: TeamCopy = {
  metaTitle: 'Команда — LEX | Кофаундери та інженерія',
  metaDescription:
    'Команда LEX: Володимир Овчаров (CEO та AI Researcher, 25+ років у CS) та Ігор Кириченко (COO та CLO, PhD у праві).',
  back: 'Назад',
  hero: {
    kicker: 'Кофаундери',
    headline: 'Команда LEX.',
    lead:
      'Компанія з українським корінням, що поєднує 25+ років досвіду в computer science та AI-дослідженнях з глибокою експертизою в українському праві. Платформу побудовано end-to-end власною командою: пайплайни обробки даних, AI-оркестрація, фронтенд та інфраструктура.',
  },
  founders: [
    {
      slug: 'volodymyr',
      name: 'Володимир Овчаров',
      role: 'Кофаундер, CEO та AI Researcher',
      photo: '/team/volodymyr.jpg',
      bio:
        '25+ років у computer science та інженерії. Побудував LEX AI – AI-платформу для юридичної аналітики, що обробляє 100M+ судових рішень у 12 юрисдикціях. Раніше: 2x CTO в Сеулі (команда 30 осіб, OCaml/Haskell/Polkadot), стартап-exit (AVOX, VoIP – переможець Startup Sauna 2016, придбаний), Toptal (top 3%). Зараз тренує доменну юридичну LLM на 8xH100 (NVIDIA Innovation Lab). 14 наукових статей (93% sole-authored), 14 відкритих датасетів на HuggingFace.',
      expertise:
        'Тренування LLM (CPT, SFT, DPO на кластерах H100/A10G); legal NLP для морфологічно багатих мов; RAG-архітектура та семантичний пошук (500M+ документів); дослідження – 3 публікації arXiv у cs.CL/cs.IR, 6 рукописів готові; open-data engineering – 14 датасетів HuggingFace, включаючи найбільший неанглійський корпус для legal NLP; архітектура розподілених систем (TypeScript, PostgreSQL, Qdrant, Redis, AWS); лідерство стартапів та exit.',
      education:
        'Магістр прикладної математики, КПІ ім. Ігоря Сікорського. Аспірант (компʼютерні науки, спеціальність 122), Інститут кібернетики ім. В.М. Глушкова НАН України. Дисертація: 5/6 розділів завершено.',
      linkedin: 'https://linkedin.com/in/volodymir-ovcharov',
      email: 'volodymyr@legal.org.ua',
      github: 'https://github.com/overthelex',
      huggingface: 'https://huggingface.co/overthelex',
    },
    {
      slug: 'igor',
      name: 'Ігор Кириченко',
      role: 'Кофаундер, COO та CLO',
      photo: '/team/igor.jpg',
      bio:
        'PhD у праві, з глибокою експертизою в українській та міжнародній юридичній практиці. Директор операційного ТОВ. Відповідає за продуктовий напрямок, моделювання предметної області (таксономія 118 MCP-інструментів, шаблони workflow для litigation, доктринальне зважування в retrieval), бізнес-розвиток та партнерства з юридичними фірмами, асоціаціями адвокатів та державним сектором.',
      expertise:
        'Цивільне, господарське та кримінальне процесуальне право України; доктринальний аналіз позицій Верховного Суду; проектування правових онтологій; legal-tech go-to-market в Україні; партнерства з НААУ та Мінцифри (Дія).',
      linkedin: 'https://www.linkedin.com/in/ihor-kyrychenko-90503890/',
      email: 'igor@legal.org.ua',
      phone: '+380 67 720 63 53',
    },
  ],
  expertiseLabel: 'Ключові компетенції',
  educationLabel: 'Освіта',
  wider: {
    title: 'Розширена команда',
    body:
      'In-house інженери та контриб\'ютори: бекенд (TypeScript/Node.js), фронтенд (React 19), data engineering (PostgreSQL, Qdrant, Redis), DevOps (AWS, Docker, blue-green CI/CD) та юридичне ревʼю практикуючими українськими адвокатами. Активно співпрацюємо з незалежними open-source контриб\'юторами.',
  },
};

function pick(language: string): TeamCopy {
  return language === 'uk' || language === 'ru' ? uk : en;
}

export function AboutTeamPage() {
  const navigate = useNavigate();
  const language = useLocaleStore((s) => s.language);
  const c = pick(language);

  useDocumentMeta({
    title: c.metaTitle,
    description: c.metaDescription,
    ogTitle: c.metaTitle,
    ogDescription: c.metaDescription,
  });


  return (
    <div className="min-h-screen bg-gradient-to-br from-claude-bg via-white to-claude-sidebar">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-claude-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => navigate('/about')}
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

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-14"
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

        <div className="space-y-8">
          {c.founders.map((f, i) => (
            <FounderCard
              key={f.slug}
              f={f}
              expertiseLabel={c.expertiseLabel}
              educationLabel={c.educationLabel}
              delay={i * 0.08}
            />
          ))}
        </div>

      </div>
    </div>
  );
}

function FounderCard({
  f,
  expertiseLabel,
  educationLabel,
  delay,
}: {
  f: Founder;
  expertiseLabel: string;
  educationLabel: string;
  delay: number;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const initials = f.name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay }}
      className="rounded-2xl bg-white border border-claude-border overflow-hidden"
    >
      <div className="grid sm:grid-cols-[180px_1fr] gap-0">
        <div className="relative bg-gradient-to-br from-claude-bg to-claude-sidebar h-48 sm:h-full flex items-center justify-center">
          {!photoFailed ? (
            <img
              src={f.photo}
              alt={f.name}
              className="w-full h-full object-cover"
              onError={() => setPhotoFailed(true)}
            />
          ) : (
            <div className="w-24 h-24 rounded-full bg-claude-accent/10 text-claude-accent font-serif text-3xl flex items-center justify-center">
              {initials}
            </div>
          )}
        </div>
        <div className="p-6 sm:p-8">
          <h2 className="text-2xl font-serif text-claude-text font-medium">{f.name}</h2>
          <p className="text-sm font-sans text-claude-accent mt-1 mb-4">{f.role}</p>
          <p className="text-sm text-claude-text font-sans leading-relaxed mb-5">{f.bio}</p>

          <div className="space-y-3 text-sm font-sans">
            <div>
              <p className="text-xs uppercase tracking-wider text-claude-subtext font-semibold mb-1.5">
                {expertiseLabel}
              </p>
              <p className="text-claude-subtext leading-relaxed">{f.expertise}</p>
            </div>
            {f.education && (
              <div>
                <p className="text-xs uppercase tracking-wider text-claude-subtext font-semibold mb-1.5">
                  {educationLabel}
                </p>
                <p className="text-claude-subtext leading-relaxed">{f.education}</p>
              </div>
            )}
          </div>

          <div className="mt-5 pt-5 border-t border-claude-border flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-sans">
            <a
              href={f.linkedin}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-claude-subtext hover:text-claude-accent transition-colors"
            >
              <Linkedin size={14} />
              LinkedIn
            </a>
            <a
              href={`mailto:${f.email}`}
              className="inline-flex items-center gap-1.5 text-claude-subtext hover:text-claude-accent transition-colors"
            >
              <Mail size={14} />
              {f.email}
            </a>
            {f.github && (
              <a
                href={f.github}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-claude-subtext hover:text-claude-accent transition-colors"
              >
                <Github size={14} />
                GitHub
              </a>
            )}
            {f.huggingface && (
              <a
                href={f.huggingface}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-claude-subtext hover:text-claude-accent transition-colors"
              >
                <span className="text-xs font-bold">🤗</span>
                HuggingFace
              </a>
            )}
            {f.phone && (
              <a
                href={`tel:${f.phone.replace(/\s+/g, '')}`}
                className="inline-flex items-center gap-1.5 text-claude-subtext hover:text-claude-accent transition-colors"
              >
                <Phone size={14} />
                {f.phone}
              </a>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
