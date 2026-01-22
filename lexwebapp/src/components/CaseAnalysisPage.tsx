import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText,
  Users,
  Scale,
  BookOpen,
  TrendingUp,
  Calendar,
  CheckCircle,
  Loader,
  ArrowLeft,
  Network,
  Clock } from
'lucide-react';
interface CaseAnalysisPageProps {
  onBack?: () => void;
}
interface RelatedDecision {
  id: string;
  number: string;
  court: string;
  date: string;
  similarity: number;
  summary: string;
}
interface TimelineEvent {
  year: number;
  decision: string;
  impact: 'positive' | 'negative' | 'neutral';
  description: string;
}
export function CaseAnalysisPage({ onBack }: CaseAnalysisPageProps) {
  const [loadingStage, setLoadingStage] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [category, setCategory] = useState('');
  const [parties, setParties] = useState({
    plaintiff: '',
    defendant: ''
  });
  const [subject, setSubject] = useState('');
  const [legalBasis, setLegalBasis] = useState('');
  const [showGraph, setShowGraph] = useState(false);
  const loadingStages = [
  {
    icon: FileText,
    text: 'Анализ категории спора',
    progress: 25
  },
  {
    icon: Users,
    text: 'Идентификация сторон',
    progress: 50
  },
  {
    icon: Scale,
    text: 'Определение правовых оснований',
    progress: 75
  },
  {
    icon: BookOpen,
    text: 'Поиск релевантной практики',
    progress: 100
  }];

  const relatedDecisions: RelatedDecision[] = [
  {
    id: '1',
    number: '№ А40-123456/2023',
    court: 'Верховный Суд',
    date: '15.11.2023',
    similarity: 95,
    summary:
    'Взыскание задолженности по договору поставки с учетом неустойки'
  },
  {
    id: '2',
    number: '№ А40-234567/2023',
    court: 'АС Московской области',
    date: '03.10.2023',
    similarity: 87,
    summary: 'Применение сроков исковой давности при взыскании долга'
  },
  {
    id: '3',
    number: '№ А40-345678/2022',
    court: 'АС г. Москвы',
    date: '22.08.2022',
    similarity: 78,
    summary: 'Расчет неустойки с учетом ст. 333 ГК РФ'
  },
  {
    id: '4',
    number: '№ А40-456789/2022',
    court: 'Девятый ААС',
    date: '15.06.2022',
    similarity: 72,
    summary: 'Доказывание факта поставки товара'
  },
  {
    id: '5',
    number: '№ А40-567890/2021',
    court: 'АС г. Москвы',
    date: '10.12.2021',
    similarity: 65,
    summary: 'Встречные требования по договору поставки'
  }];

  const timeline: TimelineEvent[] = [
  {
    year: 2024,
    decision: 'Постановление ВС РФ',
    impact: 'positive',
    description: 'Уточнение порядка применения неустойки'
  },
  {
    year: 2023,
    decision: 'Обзор судебной практики',
    impact: 'neutral',
    description: 'Систематизация подходов к расчету убытков'
  },
  {
    year: 2022,
    decision: 'Постановление Пленума',
    impact: 'positive',
    description: 'Разъяснения по срокам исковой давности'
  },
  {
    year: 2021,
    decision: 'Определение ВС РФ',
    impact: 'negative',
    description: 'Ужесточение требований к доказательствам'
  },
  {
    year: 2020,
    decision: 'Постановление ВС РФ',
    impact: 'positive',
    description: 'Либерализация подходов к договорным спорам'
  }];

  useEffect(() => {
    const stages = [0, 1, 2, 3];
    let currentStage = 0;
    const interval = setInterval(() => {
      if (currentStage < stages.length) {
        setLoadingStage(stages[currentStage]);
        currentStage++;
      } else {
        clearInterval(interval);
        setTimeout(() => {
          setIsLoading(false);
          setCategory('Арбитражный спор');
          setParties({
            plaintiff: 'ООО "ТехноСтрой"',
            defendant: 'ООО "Логистик Плюс"'
          });
          setSubject('Взыскание задолженности по договору поставки');
          setLegalBasis('ст. 309, 310, 330 ГК РФ');
        }, 500);
      }
    }, 800);
    return () => clearInterval(interval);
  }, []);
  if (isLoading) {
    return (
      <div className="flex-1 h-full flex items-center justify-center bg-claude-bg p-8">
        <motion.div
          initial={{
            opacity: 0,
            scale: 0.9
          }}
          animate={{
            opacity: 1,
            scale: 1
          }}
          className="max-w-md w-full">

          <div className="bg-white rounded-2xl border border-claude-border shadow-xl p-8">
            <div className="text-center mb-8">
              <motion.div
                animate={{
                  rotate: 360
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                  ease: 'linear'
                }}
                className="inline-block mb-4">

                <Loader size={48} className="text-claude-accent" />
              </motion.div>
              <h2 className="text-2xl font-serif text-claude-text font-medium mb-2">
                Анализ контекста дела
              </h2>
              <p className="text-claude-subtext font-sans text-sm">
                Система обрабатывает информацию...
              </p>
            </div>

            <div className="space-y-4">
              {loadingStages.map((stage, index) => {
                const StageIcon = stage.icon;
                const isActive = index === loadingStage;
                const isComplete = index < loadingStage;
                return (
                  <motion.div
                    key={index}
                    initial={{
                      opacity: 0,
                      x: -20
                    }}
                    animate={{
                      opacity: 1,
                      x: 0
                    }}
                    transition={{
                      delay: index * 0.1
                    }}
                    className={`flex items-center gap-3 p-3 rounded-xl transition-all ${isActive ? 'bg-claude-accent/10 border border-claude-accent/20' : isComplete ? 'bg-green-50 border border-green-200' : 'bg-claude-bg border border-transparent'}`}>

                    <div
                      className={`w-10 h-10 rounded-lg flex items-center justify-center ${isActive ? 'bg-claude-accent text-white' : isComplete ? 'bg-green-500 text-white' : 'bg-white text-claude-subtext border border-claude-border'}`}>

                      {isComplete ?
                      <CheckCircle size={20} /> :

                      <StageIcon size={20} />
                      }
                    </div>
                    <div className="flex-1">
                      <p
                        className={`text-sm font-medium font-sans ${isActive || isComplete ? 'text-claude-text' : 'text-claude-subtext'}`}>

                        {stage.text}
                      </p>
                    </div>
                  </motion.div>);

              })}
            </div>

            <div className="mt-6">
              <div className="h-2 bg-claude-bg rounded-full overflow-hidden">
                <motion.div
                  initial={{
                    width: 0
                  }}
                  animate={{
                    width: `${loadingStages[loadingStage]?.progress || 0}%`
                  }}
                  transition={{
                    duration: 0.5
                  }}
                  className="h-full bg-claude-accent" />

              </div>
            </div>
          </div>
        </motion.div>
      </div>);

  }
  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-claude-border">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-4">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              className="p-2 hover:bg-claude-bg rounded-lg transition-colors">

              <ArrowLeft size={20} className="text-claude-text" />
            </button>
            <div>
              <h1 className="text-2xl font-serif text-claude-text font-medium">
                Анализ дела
              </h1>
              <p className="text-sm text-claude-subtext font-sans">
                Контекст и связанная судебная практика
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 md:px-8 py-8 space-y-8">
        {/* Understanding Indicator */}
        <motion.div
          initial={{
            opacity: 0,
            y: 20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-2xl p-6">

          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-green-500 rounded-xl flex items-center justify-center flex-shrink-0">
              <CheckCircle size={24} className="text-white" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-serif text-claude-text font-medium mb-2">
                Система поняла суть спора
              </h3>
              <p className="text-sm text-claude-subtext font-sans mb-4">
                Контекст дела успешно проанализирован. Найдено 127 релевантных
                судебных решений.
              </p>
              <div className="flex items-center gap-4 text-sm font-sans">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                  <span className="text-claude-text">
                    Высокая релевантность
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                  <span className="text-claude-text">Актуальная практика</span>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Case Context */}
        <motion.div
          initial={{
            opacity: 0,
            y: 20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          transition={{
            delay: 0.1
          }}
          className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">

          <h2 className="text-xl font-serif text-claude-text font-medium mb-6">
            Контекст дела
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                Категория спора
              </label>
              <div className="px-4 py-3 bg-claude-bg rounded-xl border border-claude-border">
                <p className="text-claude-text font-sans">{category}</p>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                Предмет спора
              </label>
              <div className="px-4 py-3 bg-claude-bg rounded-xl border border-claude-border">
                <p className="text-claude-text font-sans">{subject}</p>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                Истец
              </label>
              <div className="px-4 py-3 bg-claude-bg rounded-xl border border-claude-border">
                <p className="text-claude-text font-sans">
                  {parties.plaintiff}
                </p>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                Ответчик
              </label>
              <div className="px-4 py-3 bg-claude-bg rounded-xl border border-claude-border">
                <p className="text-claude-text font-sans">
                  {parties.defendant}
                </p>
              </div>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                Правовые основания
              </label>
              <div className="px-4 py-3 bg-claude-bg rounded-xl border border-claude-border">
                <p className="text-claude-text font-sans">{legalBasis}</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Related Decisions Graph */}
        <motion.div
          initial={{
            opacity: 0,
            y: 20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          transition={{
            delay: 0.2
          }}
          className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">

          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-claude-accent/10 rounded-lg flex items-center justify-center">
                <Network size={20} className="text-claude-accent" />
              </div>
              <div>
                <h2 className="text-xl font-serif text-claude-text font-medium">
                  Граф связанных решений
                </h2>
                <p className="text-sm text-claude-subtext font-sans">
                  Визуализация близости к текущему делу
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowGraph(!showGraph)}
              className="px-4 py-2 bg-claude-accent text-white rounded-xl text-sm font-medium font-sans hover:bg-[#C66345] transition-colors">

              {showGraph ? 'Скрыть граф' : 'Показать граф'}
            </button>
          </div>

          <AnimatePresence>
            {showGraph &&
            <motion.div
              initial={{
                height: 0,
                opacity: 0
              }}
              animate={{
                height: 'auto',
                opacity: 1
              }}
              exit={{
                height: 0,
                opacity: 0
              }}
              transition={{
                duration: 0.3
              }}
              className="overflow-hidden mb-6">

                <div className="relative h-64 bg-claude-bg rounded-xl border border-claude-border p-4">
                  {/* Central node */}
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                    <motion.div
                    initial={{
                      scale: 0
                    }}
                    animate={{
                      scale: 1
                    }}
                    className="w-20 h-20 bg-claude-accent rounded-full flex items-center justify-center shadow-lg">

                      <Scale size={32} className="text-white" />
                    </motion.div>
                    <p className="text-xs text-center mt-2 font-sans text-claude-text font-medium">
                      Текущее дело
                    </p>
                  </div>

                  {/* Connected nodes */}
                  {relatedDecisions.slice(0, 5).map((decision, index) => {
                  const angle = index * 72 * Math.PI / 180;
                  const radius = 100;
                  const x = Math.cos(angle) * radius;
                  const y = Math.sin(angle) * radius;
                  return (
                    <motion.div
                      key={decision.id}
                      initial={{
                        scale: 0,
                        opacity: 0
                      }}
                      animate={{
                        scale: 1,
                        opacity: 1
                      }}
                      transition={{
                        delay: index * 0.1 + 0.3
                      }}
                      className="absolute top-1/2 left-1/2"
                      style={{
                        transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`
                      }}>

                        <div
                        className={`w-12 h-12 rounded-full flex items-center justify-center shadow-md ${decision.similarity > 85 ? 'bg-green-500' : decision.similarity > 70 ? 'bg-amber-500' : 'bg-gray-400'}`}>

                          <FileText size={20} className="text-white" />
                        </div>
                        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 whitespace-nowrap">
                          <p className="text-xs font-sans text-claude-subtext">
                            {decision.similarity}%
                          </p>
                        </div>
                      </motion.div>);

                })}
                </div>
              </motion.div>
            }
          </AnimatePresence>

          <div className="space-y-3">
            {relatedDecisions.map((decision, index) =>
            <motion.div
              key={decision.id}
              initial={{
                opacity: 0,
                x: -20
              }}
              animate={{
                opacity: 1,
                x: 0
              }}
              transition={{
                delay: index * 0.05 + 0.3
              }}
              className="flex items-start gap-4 p-4 bg-claude-bg rounded-xl border border-claude-border hover:border-claude-accent/30 transition-all cursor-pointer group">

                <div className="flex-shrink-0">
                  <div
                  className={`w-16 h-16 rounded-xl flex flex-col items-center justify-center ${decision.similarity > 85 ? 'bg-green-100 text-green-700' : decision.similarity > 70 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-700'}`}>

                    <span className="text-2xl font-serif font-bold">
                      {decision.similarity}
                    </span>
                    <span className="text-xs font-sans">%</span>
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="text-base font-serif font-medium text-claude-text group-hover:text-claude-accent transition-colors">
                      {decision.number}
                    </h3>
                    <span className="text-xs text-claude-subtext font-sans whitespace-nowrap">
                      {decision.date}
                    </span>
                  </div>
                  <p className="text-sm text-claude-subtext font-sans mb-2">
                    {decision.court}
                  </p>
                  <p className="text-sm text-claude-text font-sans">
                    {decision.summary}
                  </p>
                </div>
              </motion.div>
            )}
          </div>
        </motion.div>

        {/* Timeline */}
        <motion.div
          initial={{
            opacity: 0,
            y: 20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          transition={{
            delay: 0.3
          }}
          className="bg-white rounded-2xl border border-claude-border shadow-sm p-6">

          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
              <Clock size={20} className="text-blue-600" />
            </div>
            <div>
              <h2 className="text-xl font-serif text-claude-text font-medium">
                Эволюция судебной практики
              </h2>
              <p className="text-sm text-claude-subtext font-sans">
                Временная шкала ключевых решений
              </p>
            </div>
          </div>

          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-8 top-0 bottom-0 w-0.5 bg-claude-border"></div>

            <div className="space-y-6">
              {timeline.map((event, index) =>
              <motion.div
                key={index}
                initial={{
                  opacity: 0,
                  x: -20
                }}
                animate={{
                  opacity: 1,
                  x: 0
                }}
                transition={{
                  delay: index * 0.1 + 0.4
                }}
                className="relative flex gap-6">

                  {/* Year marker */}
                  <div className="flex-shrink-0 w-16">
                    <div
                    className={`w-16 h-16 rounded-xl flex items-center justify-center font-serif font-bold text-lg ${event.impact === 'positive' ? 'bg-green-100 text-green-700' : event.impact === 'negative' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}`}>

                      {event.year}
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex-1 pb-6">
                    <div className="bg-claude-bg rounded-xl border border-claude-border p-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <h3 className="text-base font-serif font-medium text-claude-text">
                          {event.decision}
                        </h3>
                        <span
                        className={`px-2 py-1 rounded text-xs font-medium font-sans ${event.impact === 'positive' ? 'bg-green-100 text-green-700' : event.impact === 'negative' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}`}>

                          {event.impact === 'positive' ?
                        'Позитивно' :
                        event.impact === 'negative' ?
                        'Негативно' :
                        'Нейтрально'}
                        </span>
                      </div>
                      <p className="text-sm text-claude-subtext font-sans">
                        {event.description}
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </div>);

}