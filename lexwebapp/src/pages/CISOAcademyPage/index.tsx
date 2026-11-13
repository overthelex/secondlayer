import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Shield,
  Network,
  Terminal,
  Lock,
  Bug,
  Globe,
  Code2,
  KeyRound,
  FileSearch,
  Wrench,
  Eye,
  Cloud,
  Award,
  Briefcase,
  ChevronDown,
  BookOpen,
  Clock,
  Target,
  Flame,
  ExternalLink,
  GraduationCap,
  ListChecks,
  Copy,
  Check,
  Container,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useDocumentMeta } from '../../hooks/useDocumentMeta';
import { useLocaleStore } from '../../stores/localeStore';
import { LangToggle } from '../AboutPage/LangToggle';
import { getCISOAcademyCopy } from './copy';
import { getWeeksForMonth, type Week } from './weeks';
import { getWeekContent } from './content';

type PhaseKey = 0 | 1 | 2 | 3;

const PHASE_STYLES = [
  { color: 'text-emerald-700', borderColor: 'border-emerald-300', bgColor: 'bg-emerald-50', dotColor: 'bg-emerald-600' },
  { color: 'text-amber-700', borderColor: 'border-amber-300', bgColor: 'bg-amber-50', dotColor: 'bg-amber-600' },
  { color: 'text-blue-700', borderColor: 'border-blue-300', bgColor: 'bg-blue-50', dotColor: 'bg-blue-600' },
  { color: 'text-violet-700', borderColor: 'border-violet-300', bgColor: 'bg-violet-50', dotColor: 'bg-violet-600' },
];

const MONTH_ICONS = [
  <Network size={18} />, <Terminal size={18} />, <Lock size={18} />,
  <Bug size={18} />, <Flame size={18} />, <Globe size={18} />, <KeyRound size={18} />,
  <FileSearch size={18} />, <Wrench size={18} />, <Eye size={18} />, <Cloud size={18} />,
  <Award size={18} />, <Briefcase size={18} />,
];

interface LabTool {
  id: string;
  name: string;
  descEn: string;
  descUk: string;
  port: string;
  steps: { labelEn: string; labelUk: string; cmd: string }[];
}

const LAB_TOOLS: LabTool[] = [
  {
    id: 'dvwa',
    name: 'DVWA',
    descEn: 'Damn Vulnerable Web Application — classic training ground for web vulnerabilities',
    descUk: 'Damn Vulnerable Web Application — класичний полігон для веб-вразливостей',
    port: '4280',
    steps: [
      { labelEn: 'Pull and run the container', labelUk: 'Завантажити та запустити контейнер', cmd: 'docker run -d --name dvwa -p 4280:80 vulnerables/web-dvwa' },
      { labelEn: 'Open in browser', labelUk: 'Відкрити у браузері', cmd: 'http://localhost:4280' },
      { labelEn: 'Login: admin / password, then click "Create / Reset Database"', labelUk: 'Логін: admin / password, потім натиснути "Create / Reset Database"', cmd: '' },
    ],
  },
  {
    id: 'juice-shop',
    name: 'OWASP Juice Shop',
    descEn: 'Modern vulnerable application with 100+ challenges covering OWASP Top 10',
    descUk: 'Сучасний вразливий застосунок з 100+ завданнями за OWASP Top 10',
    port: '3000',
    steps: [
      { labelEn: 'Pull and run the container', labelUk: 'Завантажити та запустити контейнер', cmd: 'docker run -d --name juice-shop -p 3000:3000 bkimminich/juice-shop' },
      { labelEn: 'Open in browser', labelUk: 'Відкрити у браузері', cmd: 'http://localhost:3000' },
      { labelEn: 'Open the scoreboard to track progress', labelUk: 'Відкрити scoreboard для відстеження прогресу', cmd: 'http://localhost:3000/#/score-board' },
    ],
  },
  {
    id: 'crapi',
    name: 'OWASP crAPI',
    descEn: 'Completely Ridiculous API — vulnerable API for OWASP API Top 10 training',
    descUk: 'Completely Ridiculous API — вразливий API для тренування OWASP API Top 10',
    port: '8888',
    steps: [
      { labelEn: 'Clone the repository', labelUk: 'Клонувати репозиторій', cmd: 'git clone https://github.com/OWASP/crAPI.git && cd crAPI/deploy/docker' },
      { labelEn: 'Start with docker compose', labelUk: 'Запустити через docker compose', cmd: 'docker compose -f docker-compose.yml up -d' },
      { labelEn: 'Open in browser', labelUk: 'Відкрити у браузері', cmd: 'http://localhost:8888' },
    ],
  },
  {
    id: 'dvga',
    name: 'DVGA (GraphQL)',
    descEn: 'Damn Vulnerable GraphQL Application — GraphQL-specific vulnerability training',
    descUk: 'Damn Vulnerable GraphQL Application — тренування вразливостей GraphQL',
    port: '5013',
    steps: [
      { labelEn: 'Pull and run the container', labelUk: 'Завантажити та запустити контейнер', cmd: 'docker run -d --name dvga -p 5013:5013 -e WEB_HOST=0.0.0.0 dolevf/dvga' },
      { labelEn: 'Open in browser', labelUk: 'Відкрити у браузері', cmd: 'http://localhost:5013' },
    ],
  },
  {
    id: 'vampi',
    name: 'VAmPI',
    descEn: 'Vulnerable REST API built with Flask — OWASP API Top 10 vulnerabilities',
    descUk: 'Вразливий REST API на Flask — вразливості OWASP API Top 10',
    port: '5000',
    steps: [
      { labelEn: 'Pull and run the container', labelUk: 'Завантажити та запустити контейнер', cmd: 'docker run -d --name vampi -p 5000:5000 erev0s/vampi' },
      { labelEn: 'Check API docs', labelUk: 'Перевірити документацію API', cmd: 'http://localhost:5000' },
    ],
  },
  {
    id: 'zap',
    name: 'OWASP ZAP',
    descEn: 'Zed Attack Proxy — free DAST scanner with web UI',
    descUk: 'Zed Attack Proxy — безкоштовний DAST-сканер з веб-інтерфейсом',
    port: '8080',
    steps: [
      { labelEn: 'Run ZAP with web UI', labelUk: 'Запустити ZAP з веб-інтерфейсом', cmd: 'docker run -d --name zap -u zap -p 8080:8080 -p 8090:8090 ghcr.io/zaproxy/zaproxy zap-webswing.sh' },
      { labelEn: 'Open ZAP web UI', labelUk: 'Відкрити веб-інтерфейс ZAP', cmd: 'http://localhost:8080/zap/' },
    ],
  },
  {
    id: 'kali',
    name: 'Kali Linux',
    descEn: 'Security-focused Linux distribution with 600+ pre-installed tools',
    descUk: 'Linux-дистрибутив для безпеки з 600+ попередньо встановлених інструментів',
    port: '6080',
    steps: [
      { labelEn: 'Run Kali with desktop (VNC in browser)', labelUk: 'Запустити Kali з десктопом (VNC у браузері)', cmd: 'docker run -d --name kali -p 6080:6080 --shm-size=512m kasmweb/kali-rolling-desktop:1.16.1' },
      { labelEn: 'Open desktop in browser', labelUk: 'Відкрити десктоп у браузері', cmd: 'https://localhost:6080' },
      { labelEn: 'Default credentials: kasm_user / password', labelUk: 'Логін за замовчуванням: kasm_user / password', cmd: '' },
    ],
  },
  {
    id: 'keycloak',
    name: 'Keycloak',
    descEn: 'Open-source IAM — for OAuth/OIDC/SAML attack practice (weeks 25-27)',
    descUk: 'Open-source IAM — для практики атак OAuth/OIDC/SAML (тижні 25-27)',
    port: '8443',
    steps: [
      { labelEn: 'Run Keycloak in dev mode', labelUk: 'Запустити Keycloak у dev-режимі', cmd: 'docker run -d --name keycloak -p 8443:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak:26.0 start-dev' },
      { labelEn: 'Open admin console', labelUk: 'Відкрити адмін-консоль', cmd: 'http://localhost:8443' },
      { labelEn: 'Login: admin / admin', labelUk: 'Логін: admin / admin', cmd: '' },
    ],
  },
];

function CopyButton({ text, copiedCmd, setCopiedCmd }: { text: string; copiedCmd: string | null; setCopiedCmd: (v: string | null) => void }) {
  const isCopied = copiedCmd === text;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopiedCmd(text);
        setTimeout(() => setCopiedCmd(null), 2000);
      }}
      className="flex-shrink-0 p-1 rounded hover:bg-claude-sidebar transition-colors"
      title="Copy"
    >
      {isCopied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} className="text-claude-subtext" />}
    </button>
  );
}

function LabSetupPanel({ language, expandedLab, setExpandedLab, copiedCmd, setCopiedCmd }: {
  language: string;
  expandedLab: string | null;
  setExpandedLab: (v: string | null) => void;
  copiedCmd: string | null;
  setCopiedCmd: (v: string | null) => void;
}) {
  const isEn = language !== 'uk' && language !== 'ru';
  return (
    <div className="mt-6 rounded-xl border border-claude-border bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-claude-border bg-claude-bg">
        <div className="flex items-center gap-2">
          <Container size={14} className="text-claude-accent" />
          <p className="text-xs font-sans font-semibold text-claude-text uppercase tracking-wide">
            {isEn ? 'Lab Environment' : 'Лабораторне середовище'}
          </p>
        </div>
        <p className="text-[11px] font-sans text-claude-subtext mt-1">
          {isEn ? 'Docker setup — click to expand' : 'Docker setup — натисни для деталей'}
        </p>
      </div>
      <div className="divide-y divide-claude-border/50">
        {LAB_TOOLS.map((tool) => {
          const isOpen = expandedLab === tool.id;
          return (
            <div key={tool.id}>
              <button
                onClick={() => setExpandedLab(isOpen ? null : tool.id)}
                className="w-full text-left px-4 py-2.5 flex items-center gap-2 hover:bg-claude-bg/50 transition-colors"
              >
                <span className="w-5 h-5 rounded bg-claude-accent/10 text-claude-accent flex items-center justify-center flex-shrink-0">
                  <Container size={11} />
                </span>
                <span className="flex-1 text-xs font-sans font-medium text-claude-text">{tool.name}</span>
                <span className="text-[10px] font-sans text-claude-subtext">:{tool.port}</span>
                <ChevronDown size={12} className={`text-claude-subtext transition-transform ${isOpen ? 'rotate-180' : ''}`} />
              </button>
              <AnimatePresence>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-3 pt-0">
                      <p className="text-[11px] font-sans text-claude-subtext mb-2">
                        {isEn ? tool.descEn : tool.descUk}
                      </p>
                      <ol className="space-y-2">
                        {tool.steps.map((step, i) => (
                          <li key={i}>
                            <p className="text-[11px] font-sans text-claude-text font-medium mb-1">
                              {i + 1}. {isEn ? step.labelEn : step.labelUk}
                            </p>
                            {step.cmd && (
                              step.cmd.startsWith('http') ? (
                                <a
                                  href={step.cmd}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-claude-bg text-[11px] font-mono text-claude-accent hover:underline"
                                >
                                  {step.cmd}
                                  <ExternalLink size={9} />
                                </a>
                              ) : (
                                <div className="flex items-center gap-1 px-2 py-1 rounded bg-zinc-900 group">
                                  <code className="flex-1 text-[11px] font-mono text-emerald-400 overflow-x-auto whitespace-nowrap">
                                    $ {step.cmd}
                                  </code>
                                  <CopyButton text={step.cmd} copiedCmd={copiedCmd} setCopiedCmd={setCopiedCmd} />
                                </div>
                              )
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CISOAcademyPage() {
  const navigate = useNavigate();
  const language = useLocaleStore((s) => s.language);
  const c = getCISOAcademyCopy(language);
  const [activePhase, setActivePhase] = useState<PhaseKey>(0);
  const [expandedMonth, setExpandedMonth] = useState<number>(0);
  const [expandedWeek, setExpandedWeek] = useState<number | null>(null);
  const [expandedLab, setExpandedLab] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  useDocumentMeta({
    title: c.metaTitle,
    description: c.metaDescription,
    ogTitle: c.metaTitle,
    ogDescription: c.metaDescription,
    canonical: 'https://legal.org.ua/cisoacademy',
  });


  const phase = c.phases[activePhase];
  const style = PHASE_STYLES[activePhase];
  const totalMonths = c.phases.reduce((sum, p) => sum + p.data.length, 0);

  let globalMonthIdx = 0;
  for (let i = 0; i < activePhase; i++) globalMonthIdx += c.phases[i].data.length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-claude-bg via-white to-claude-sidebar">
      {/* Header — matches About/Product pattern */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-md border-b border-claude-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => navigate('/career')}
            className="flex items-center gap-2 text-claude-subtext hover:text-claude-text transition-colors font-sans text-sm"
          >
            <ArrowLeft size={16} />
            {c.back}
          </button>
          <div className="hidden md:flex items-center gap-1 ml-4">
            {c.phases.map((p, idx) => (
              <button
                key={idx}
                onClick={() => { setActivePhase(idx as PhaseKey); setExpandedMonth(0); }}
                className={`px-3 py-1.5 rounded-lg font-sans text-xs font-medium transition-all ${
                  activePhase === idx
                    ? `${PHASE_STYLES[idx].bgColor} ${PHASE_STYLES[idx].color}`
                    : 'text-claude-subtext hover:text-claude-text hover:bg-claude-sidebar'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <div className="hidden sm:flex items-center gap-2 text-xs font-sans text-claude-subtext">
            <Clock size={14} />
            <span>{totalMonths} {c.duration}</span>
          </div>
          <LangToggle />
          <img src="/Image.jpg" alt="LEX" className="h-9 w-auto" />
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-14"
        >
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 rounded-xl bg-claude-accent flex items-center justify-center">
              <Shield size={22} className="text-white" />
            </div>
            <div>
              <p className="text-xs font-sans font-semibold text-claude-accent uppercase tracking-[0.18em]">
                {c.kicker}
              </p>
              <p className="text-xs font-sans text-claude-subtext">
                {c.subKicker}
              </p>
            </div>
          </div>
          <h1 className="text-3xl sm:text-5xl lg:text-6xl font-serif text-claude-text font-medium leading-tight mb-6 max-w-3xl">
            {c.headline}
            <br />
            <span className="text-claude-subtext">{c.headlineFaded}</span>
          </h1>
          <p className="text-base sm:text-lg text-claude-subtext font-sans leading-relaxed max-w-2xl mb-8">
            {c.lead}
          </p>

          <div className="inline-flex items-start gap-3 px-5 py-4 rounded-xl border border-claude-border bg-white">
            <Target size={18} className="text-claude-accent mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-sans font-medium text-claude-text mb-1">{c.prereqTitle}</p>
              <p className="text-sm font-sans text-claude-subtext leading-relaxed">
                {c.prereqBody}
              </p>
            </div>
          </div>
        </motion.div>

        {/* Progress bar */}
        <div className="rounded-xl border border-claude-border bg-white p-4 mb-10">
          <div className="flex items-center gap-1">
            {c.phases.map((p, pIdx) => (
              <div key={pIdx} className="flex-1 flex items-center gap-1">
                {p.data.map((_, mIdx) => {
                  let gIdx = 0;
                  for (let i = 0; i < pIdx; i++) gIdx += c.phases[i].data.length;
                  gIdx += mIdx;
                  const isActive = activePhase === pIdx && expandedMonth === mIdx;
                  const isPhase = activePhase === pIdx;
                  return (
                    <button
                      key={mIdx}
                      onClick={() => { setActivePhase(pIdx as PhaseKey); setExpandedMonth(mIdx); }}
                      className={`flex-1 h-2 rounded-full transition-all ${
                        isActive ? PHASE_STYLES[pIdx].dotColor
                          : isPhase ? `${PHASE_STYLES[pIdx].dotColor} opacity-30`
                          : 'bg-claude-border'
                      }`}
                      title={`${gIdx + 1}: ${p.data[mIdx].title}`}
                    />
                  );
                })}
                {pIdx < 3 && <div className="w-3" />}
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2">
            {c.phases.map((p, idx) => (
              <p key={idx} className={`text-[10px] font-sans font-medium uppercase tracking-wider ${
                activePhase === idx ? PHASE_STYLES[idx].color : 'text-claude-subtext/50'
              }`}>
                {p.months}
              </p>
            ))}
          </div>
        </div>

        {/* Main content */}
        <div className="grid lg:grid-cols-[260px_1fr] gap-8">
          {/* Phase sidebar */}
          <div className="lg:sticky lg:top-24 lg:self-start space-y-2">
            {c.phases.map((p, idx) => (
              <motion.button
                key={idx}
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, delay: idx * 0.05 }}
                onClick={() => { setActivePhase(idx as PhaseKey); setExpandedMonth(0); }}
                className={`w-full text-left px-4 py-3 rounded-xl transition-all ${
                  activePhase === idx
                    ? `${PHASE_STYLES[idx].bgColor} ${PHASE_STYLES[idx].borderColor} border`
                    : 'hover:bg-claude-sidebar border border-transparent'
                }`}
              >
                <p className={`text-[10px] font-sans font-bold uppercase tracking-[0.15em] mb-1 ${
                  activePhase === idx ? PHASE_STYLES[idx].color : 'text-claude-subtext'
                }`}>
                  {p.label} · {p.months}
                </p>
                <p className={`text-sm font-serif font-medium ${
                  activePhase === idx ? 'text-claude-text' : 'text-claude-subtext'
                }`}>
                  {p.title}
                </p>
              </motion.button>
            ))}

            <LabSetupPanel
              language={language}
              expandedLab={expandedLab}
              setExpandedLab={setExpandedLab}
              copiedCmd={copiedCmd}
              setCopiedCmd={setCopiedCmd}
            />
          </div>

          {/* Phase content */}
          <div>
            <AnimatePresence mode="wait">
              <motion.div
                key={activePhase}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.35 }}
              >
                {/* Phase header */}
                <div className={`rounded-xl ${style.bgColor} border ${style.borderColor} p-6 mb-6`}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className={`text-xs font-sans font-bold uppercase tracking-[0.15em] ${style.color} mb-2`}>
                        {phase.label}
                      </p>
                      <h2 className="text-2xl font-serif text-claude-text font-medium mb-2">
                        {phase.title}
                      </h2>
                      <p className="text-sm font-sans text-claude-subtext leading-relaxed max-w-xl">
                        {phase.description}
                      </p>
                    </div>
                    <div className={`flex-shrink-0 w-14 h-14 rounded-2xl ${style.dotColor} flex items-center justify-center`}>
                      <span className="text-white font-sans font-bold text-lg">
                        {phase.data.length}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Months */}
                <div className="space-y-3">
                  {phase.data.map((month, mIdx) => {
                    const monthNum = globalMonthIdx + mIdx + 1;
                    const isExpanded = expandedMonth === mIdx;
                    const icon = MONTH_ICONS[monthNum - 1] || <Shield size={18} />;
                    return (
                      <div
                        key={mIdx}
                        className={`rounded-xl border transition-all ${
                          isExpanded
                            ? 'border-claude-accent/20 bg-white shadow-elevation-2'
                            : 'border-claude-border bg-white hover:border-claude-accent/10 hover:shadow-elevation-1'
                        }`}
                      >
                        <button
                          onClick={() => setExpandedMonth(isExpanded ? -1 : mIdx)}
                          className="w-full text-left px-6 py-5 flex items-center gap-4"
                        >
                          <div className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center font-sans font-bold text-sm ${
                            isExpanded ? `${style.dotColor} text-white` : `${style.bgColor} ${style.color}`
                          }`}>
                            {String(monthNum).padStart(2, '0')}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="text-base font-serif text-claude-text font-medium truncate">
                              {month.title}
                            </h3>
                            <p className="text-sm font-sans text-claude-subtext truncate">
                              {month.subtitle}
                            </p>
                          </div>
                          <div className="flex-shrink-0 flex items-center gap-2">
                            <span className="text-claude-subtext">{icon}</span>
                            <ChevronDown
                              size={18}
                              className={`text-claude-subtext transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                            />
                          </div>
                        </button>

                        <AnimatePresence>
                          {isExpanded && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.3 }}
                              className="overflow-hidden"
                            >
                              <div className="px-6 pb-6 pt-0">
                                <div className="border-t border-claude-border pt-5 space-y-4">
                                  {getWeeksForMonth(monthNum).map((week: Week) => {
                                    const isEn = language !== 'uk' && language !== 'ru';
                                    const wContent = getWeekContent(week.week);
                                    const isWeekOpen = expandedWeek === week.week;
                                    return (
                                      <div key={week.week} className={`rounded-lg border transition-all ${isWeekOpen ? 'border-claude-accent/20 shadow-elevation-1' : 'border-claude-border/60'} p-4`}>
                                        <button
                                          onClick={() => setExpandedWeek(isWeekOpen ? null : week.week)}
                                          className="w-full text-left"
                                        >
                                          <div className="flex items-start gap-3 mb-3">
                                            <span className={`flex-shrink-0 w-7 h-7 rounded-lg ${isWeekOpen ? `${style.dotColor} text-white` : `${style.bgColor} ${style.color}`} flex items-center justify-center text-xs font-sans font-bold transition-colors`}>
                                              {week.week}
                                            </span>
                                            <div className="flex-1 min-w-0">
                                              <h4 className="text-sm font-serif font-medium text-claude-text inline-flex items-center gap-2">
                                                {isEn ? week.titleEn : week.titleUk}
                                                {week.advanced && (
                                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-sans font-bold bg-amber-100 text-amber-700 tracking-wide">
                                                    ★ {isEn ? 'ADVANCED' : 'СКЛАДНЕ'}
                                                  </span>
                                                )}
                                              </h4>
                                              <div className="flex items-center gap-3 mt-1">
                                                <span className="inline-flex items-center gap-1">
                                                  <Clock size={11} className="text-claude-subtext" />
                                                  <span className="text-[11px] font-sans text-claude-subtext">{week.hours} {isEn ? 'hrs' : 'год'}</span>
                                                </span>
                                                {wContent && (
                                                  <span className={`text-[10px] font-sans font-medium ${style.color}`}>
                                                    {isEn ? 'Lecture + Practice' : 'Лекція + Практика'}
                                                  </span>
                                                )}
                                              </div>
                                            </div>
                                            <ChevronDown size={16} className={`text-claude-subtext transition-transform mt-1 ${isWeekOpen ? 'rotate-180' : ''}`} />
                                          </div>
                                        </button>
                                        <p className="text-xs font-sans text-claude-subtext leading-relaxed mb-2">
                                          {isEn ? week.topicsEn : week.topicsUk}
                                        </p>
                                        <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded-md bg-claude-bg">
                                          <Code2 size={12} className={`${style.color} mt-0.5 flex-shrink-0`} />
                                          <p className="text-xs font-sans text-claude-text leading-relaxed">
                                            {isEn ? week.artifactEn : week.artifactUk}
                                          </p>
                                        </div>
                                        {week.resources.length > 0 && (
                                          <div className="flex flex-wrap gap-1.5 mb-2">
                                            {week.resources.map((res) => (
                                              <a
                                                key={res.name}
                                                href={res.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-sans font-medium ${style.bgColor} ${style.color} hover:opacity-75 transition-opacity`}
                                              >
                                                {res.name}
                                                <ExternalLink size={9} />
                                              </a>
                                            ))}
                                          </div>
                                        )}
                                        <AnimatePresence>
                                          {isWeekOpen && wContent && (
                                            <motion.div
                                              initial={{ height: 0, opacity: 0 }}
                                              animate={{ height: 'auto', opacity: 1 }}
                                              exit={{ height: 0, opacity: 0 }}
                                              transition={{ duration: 0.25 }}
                                              className="overflow-hidden"
                                            >
                                              <div className="border-t border-claude-border/50 mt-3 pt-4 space-y-4">
                                                <div>
                                                  <div className="flex items-center gap-2 mb-2">
                                                    <GraduationCap size={14} className={style.color} />
                                                    <h5 className="text-xs font-sans font-semibold text-claude-text uppercase tracking-wide">
                                                      {isEn ? 'Lecture' : 'Лекція'}
                                                    </h5>
                                                  </div>
                                                  <div className="text-xs font-sans text-claude-subtext leading-relaxed space-y-2">
                                                    {wContent.lectureEn.split('\n\n').map((p, i) => (
                                                      <p key={i}>{p}</p>
                                                    ))}
                                                  </div>
                                                </div>
                                                <div>
                                                  <div className="flex items-center gap-2 mb-2">
                                                    <ListChecks size={14} className={style.color} />
                                                    <h5 className="text-xs font-sans font-semibold text-claude-text uppercase tracking-wide">
                                                      {isEn ? 'Practice' : 'Практика'}
                                                    </h5>
                                                  </div>
                                                  <ol className="space-y-1.5">
                                                    {wContent.practiceEn.map((step, i) => {
                                                      const isAdvancedStep = step.startsWith('★');
                                                      const stepText = isAdvancedStep ? step.slice(2) : step;
                                                      return (
                                                      <li key={i} className={`flex gap-2 text-xs font-sans leading-relaxed ${isAdvancedStep ? 'text-claude-text' : 'text-claude-subtext'}`}>
                                                        <span className={`flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold mt-0.5 ${isAdvancedStep ? 'bg-amber-100 text-amber-700' : `${style.bgColor} ${style.color}`}`}>
                                                          {isAdvancedStep ? '★' : i + 1}
                                                        </span>
                                                        <span>{isAdvancedStep && <span className="font-semibold text-amber-700 mr-1">{isEn ? 'Advanced:' : 'Складне:'}</span>}{stepText}</span>
                                                      </li>
                                                      );
                                                    })}
                                                  </ol>
                                                </div>
                                              </div>
                                            </motion.div>
                                          )}
                                        </AnimatePresence>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Essential reading */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mt-16 rounded-2xl border border-claude-border bg-white p-8"
        >
          <div className="flex items-center gap-3 mb-6">
            <BookOpen size={20} className="text-claude-accent" />
            <h2 className="text-xl font-serif text-claude-text font-medium">
              {c.readingTitle}
            </h2>
          </div>
          <p className="text-sm font-sans text-claude-subtext mb-6 max-w-2xl">
            {c.readingSub}
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {c.essentialReads.map((r) => (
              <a
                key={r.name}
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-3 px-4 py-3 rounded-lg bg-claude-bg hover:bg-claude-sidebar transition-colors group"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-claude-accent mt-2 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-sans font-medium text-claude-text group-hover:text-claude-accent transition-colors inline-flex items-center gap-1.5">
                    {r.name}
                    <ExternalLink size={11} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                  </p>
                  <p className="text-xs font-sans text-claude-subtext">{r.desc}</p>
                </div>
              </a>
            ))}
          </div>
        </motion.div>

        {/* Notes */}
        <div className="mt-6 rounded-2xl border border-dashed border-claude-border bg-white p-8">
          <div className="grid md:grid-cols-3 gap-6">
            <div>
              <p className="text-xs font-sans font-semibold text-claude-text uppercase tracking-wide mb-2">
                {c.noteProgTitle}
              </p>
              <p className="text-sm font-sans text-claude-subtext leading-relaxed">
                {c.noteProgBody}
              </p>
            </div>
            <div>
              <p className="text-xs font-sans font-semibold text-claude-text uppercase tracking-wide mb-2">
                {c.noteLabTitle}
              </p>
              <p className="text-sm font-sans text-claude-subtext leading-relaxed">
                {c.noteLabBody}
              </p>
            </div>
            <div>
              <p className="text-xs font-sans font-semibold text-claude-text uppercase tracking-wide mb-2">
                {c.noteCveTitle}
              </p>
              <p className="text-sm font-sans text-claude-subtext leading-relaxed">
                {c.noteCveBody}
              </p>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="mt-12 text-center">
          <p className="text-sm font-sans text-claude-subtext mb-3">
            {c.contactPre}
          </p>
          <a
            href="mailto:career@legal.org.ua"
            className="text-xl font-serif text-claude-text hover:text-claude-accent transition-colors"
          >
            career@legal.org.ua
          </a>
        </div>
      </div>
    </div>
  );
}
