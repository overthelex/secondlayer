import React, { useState, Fragment } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  CheckCircle,
  XCircle,
  Users,
  MapPin,
  Clock,
  TrendingUp,
  Download,
  ArrowLeft,
  ChevronDown,
  AlertCircle,
  Vote } from
'lucide-react';
interface VotingAnalysisPageProps {
  onBack?: () => void;
}
interface VotingResult {
  for: number;
  against: number;
  abstain: number;
  notVoted: number;
}
interface FactionVoting {
  name: string;
  for: number;
  against: number;
  abstain: number;
  notVoted: number;
  total: number;
}
const quickAccessBills = [
'Державний бюджет 2026',
'Про внесення змін до Податкового кодексу',
'Про мобілізацію',
'Про ратифікацію міжнародних угод'];

const votingResult: VotingResult = {
  for: 301,
  against: 89,
  abstain: 45,
  notVoted: 27
};
const factionVoting: FactionVoting[] = [
{
  name: 'Слуга народу',
  for: 120,
  against: 5,
  abstain: 3,
  notVoted: 2,
  total: 130
},
{
  name: 'Європейська солідарність',
  for: 56,
  against: 2,
  abstain: 1,
  notVoted: 0,
  total: 59
},
{
  name: 'Батьківщина',
  for: 45,
  against: 3,
  abstain: 2,
  notVoted: 1,
  total: 51
},
{
  name: 'Опозиційна платформа',
  for: 2,
  against: 38,
  abstain: 5,
  notVoted: 3,
  total: 48
},
{
  name: 'Голос',
  for: 34,
  against: 1,
  abstain: 2,
  notVoted: 0,
  total: 37
},
{
  name: 'Позафракційні',
  for: 44,
  against: 40,
  abstain: 32,
  notVoted: 21,
  total: 137
}];

const regionalData = [
{
  region: 'Київська область',
  deputies: 23,
  for: 18,
  against: 3,
  abstain: 2,
  percentage: 78
},
{
  region: 'Львівська область',
  deputies: 18,
  for: 16,
  against: 1,
  abstain: 1,
  percentage: 89
},
{
  region: 'Одеська область',
  deputies: 15,
  for: 9,
  against: 4,
  abstain: 2,
  percentage: 60
},
{
  region: 'Харківська область',
  deputies: 20,
  for: 14,
  against: 4,
  abstain: 2,
  percentage: 70
},
{
  region: 'Дніпропетровська область',
  deputies: 22,
  for: 17,
  against: 3,
  abstain: 2,
  percentage: 77
}];

const votingHistory = [
{
  id: 1,
  date: '12.11.2025',
  type: 'Прийняття за основу',
  result: 'approved',
  for: 278,
  against: 95,
  abstain: 52,
  notVoted: 25
},
{
  id: 2,
  date: '01.12.2025',
  type: '2-ге читання, 1-а спроба',
  result: 'approved',
  for: 245,
  against: 112,
  abstain: 68,
  notVoted: 25
},
{
  id: 3,
  date: '10.12.2025',
  type: '2-ге читання, 2-а спроба',
  result: 'rejected',
  for: 213,
  against: 145,
  abstain: 72,
  notVoted: 20
},
{
  id: 4,
  date: '15.12.2025',
  type: 'Остаточне прийняття',
  result: 'approved',
  for: 301,
  against: 89,
  abstain: 45,
  notVoted: 15
}];

export function VotingAnalysisPage({ onBack }: VotingAnalysisPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBill, setSelectedBill] = useState(false);
  const [activeTab, setActiveTab] = useState<
    'general' | 'factions' | 'regions' | 'history'>(
    'general');
  const [votingType, setVotingType] = useState('all');
  const [resultFilter, setResultFilter] = useState('all');
  const [deputySearch, setDeputySearch] = useState('');
  const total =
  votingResult.for +
  votingResult.against +
  votingResult.abstain +
  votingResult.notVoted;
  const forPercentage = Math.round(votingResult.for / total * 100);
  const againstPercentage = Math.round(votingResult.against / total * 100);
  const abstainPercentage = Math.round(votingResult.abstain / total * 100);
  const notVotedPercentage = Math.round(votingResult.notVoted / total * 100);
  if (selectedBill) {
    return (
      <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Header */}
          <motion.div
            initial={{
              opacity: 0,
              y: 20
            }}
            animate={{
              opacity: 1,
              y: 0
            }}>

            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSelectedBill(false)}
                  className="p-2 hover:bg-white rounded-lg transition-colors border border-claude-border">

                  <ArrowLeft size={20} className="text-claude-text" />
                </button>
                <div>
                  <h1 className="text-2xl md:text-3xl font-sans text-claude-text font-medium mb-1">
                    Законопроект №8234-IX "Про Державний бюджет України"
                  </h1>
                  <p className="text-sm text-claude-subtext font-sans">
                    Голосування від 15.12.2025, 14:35
                  </p>
                </div>
              </div>
            </div>

            {/* Result Badge */}
            <div className="bg-green-50 border-2 border-green-200 rounded-2xl p-4 mb-6">
              <div className="flex items-center gap-3">
                <CheckCircle size={32} className="text-green-600" />
                <div>
                  <p className="text-xl font-serif font-bold text-green-700">
                    ПРИЙНЯТО
                  </p>
                  <p className="text-sm text-green-600 font-sans">
                    301 голос за, необхідно 226
                  </p>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden mb-6">
              <div className="flex border-b border-claude-border overflow-x-auto">
                {[
                {
                  id: 'general',
                  label: 'Загальне',
                  icon: '📊'
                },
                {
                  id: 'factions',
                  label: 'По фракціям',
                  icon: '👥'
                },
                {
                  id: 'regions',
                  label: 'По регіонах',
                  icon: '📍'
                },
                {
                  id: 'history',
                  label: 'Історія',
                  icon: '⏱️'
                }].
                map((tab) =>
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium font-sans transition-colors relative whitespace-nowrap ${activeTab === tab.id ? 'text-claude-accent bg-claude-accent/5' : 'text-claude-subtext hover:text-claude-text hover:bg-claude-bg'}`}>

                    <span>{tab.icon}</span>
                    {tab.label}
                    {activeTab === tab.id &&
                  <motion.div
                    layoutId="activeVotingTab"
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-claude-accent" />

                  }
                  </button>
                )}
              </div>

              <div className="p-6">
                <AnimatePresence mode="wait">
                  {activeTab === 'general' &&
                  <motion.div
                    key="general"
                    initial={{
                      opacity: 0,
                      y: 10
                    }}
                    animate={{
                      opacity: 1,
                      y: 0
                    }}
                    exit={{
                      opacity: 0,
                      y: -10
                    }}
                    className="space-y-6">

                      {/* Gauge Visualization */}
                      <div className="flex flex-col items-center">
                        <div className="relative w-full max-w-md h-48 mb-6">
                          <svg viewBox="0 0 200 120" className="w-full h-full">
                            {/* Background arc */}
                            <path
                            d="M 20 100 A 80 80 0 0 1 180 100"
                            fill="none"
                            stroke="#E5E5E0"
                            strokeWidth="20"
                            strokeLinecap="round" />

                            {/* For arc */}
                            <motion.path
                            initial={{
                              pathLength: 0
                            }}
                            animate={{
                              pathLength: forPercentage / 100
                            }}
                            transition={{
                              duration: 1,
                              ease: 'easeOut'
                            }}
                            d="M 20 100 A 80 80 0 0 1 180 100"
                            fill="none"
                            stroke="#22c55e"
                            strokeWidth="20"
                            strokeLinecap="round" />

                            <text
                            x="100"
                            y="90"
                            textAnchor="middle"
                            className="text-3xl font-serif font-bold fill-claude-text">

                              {votingResult.for}
                            </text>
                            <text
                            x="100"
                            y="110"
                            textAnchor="middle"
                            className="text-xs fill-claude-subtext font-sans">

                              голосів ЗА
                            </text>
                          </svg>
                        </div>

                        {/* Results Grid */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full">
                          <div className="p-4 bg-green-50 rounded-xl border border-green-200">
                            <p className="text-xs text-green-700 font-sans mb-1">
                              ЗА
                            </p>
                            <p className="text-2xl font-serif font-bold text-green-700">
                              {votingResult.for}
                            </p>
                            <p className="text-xs text-green-600 font-sans">
                              {forPercentage}%
                            </p>
                          </div>
                          <div className="p-4 bg-red-50 rounded-xl border border-red-200">
                            <p className="text-xs text-red-700 font-sans mb-1">
                              ПРОТИ
                            </p>
                            <p className="text-2xl font-serif font-bold text-red-700">
                              {votingResult.against}
                            </p>
                            <p className="text-xs text-red-600 font-sans">
                              {againstPercentage}%
                            </p>
                          </div>
                          <div className="p-4 bg-amber-50 rounded-xl border border-amber-200">
                            <p className="text-xs text-amber-700 font-sans mb-1">
                              УТРИМАЛИСЯ
                            </p>
                            <p className="text-2xl font-serif font-bold text-amber-700">
                              {votingResult.abstain}
                            </p>
                            <p className="text-xs text-amber-600 font-sans">
                              {abstainPercentage}%
                            </p>
                          </div>
                          <div className="p-4 bg-gray-50 rounded-xl border border-gray-200">
                            <p className="text-xs text-gray-700 font-sans mb-1">
                              НЕ ГОЛОСУВАЛИ
                            </p>
                            <p className="text-2xl font-serif font-bold text-gray-700">
                              {votingResult.notVoted}
                            </p>
                            <p className="text-xs text-gray-600 font-sans">
                              {notVotedPercentage}%
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Quorum Info */}
                      <div className="flex items-center justify-between p-4 bg-claude-bg rounded-xl border border-claude-border">
                        <div>
                          <p className="text-sm text-claude-subtext font-sans mb-1">
                            Присутні:{' '}
                            <span className="font-medium text-claude-text">
                              435 / 450 депутатів (97%)
                            </span>
                          </p>
                          <div className="flex items-center gap-2">
                            <CheckCircle size={16} className="text-green-600" />
                            <p className="text-sm font-medium text-green-600 font-sans">
                              Кворум забезпечено
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Interesting Facts */}
                      <div className="bg-blue-50 rounded-xl border border-blue-200 p-4">
                        <h4 className="text-sm font-medium text-blue-900 font-sans mb-3 flex items-center gap-2">
                          <TrendingUp size={16} />
                          Цікаві факти
                        </h4>
                        <ul className="space-y-2 text-sm text-blue-800 font-sans">
                          <li>
                            • Найвища дисципліна: "Європейська солідарність"
                            (98%)
                          </li>
                          <li>• Найнижча дисципліна: Позафракційні (32%)</li>
                          <li>• "Переходів" (голос проти лінії фракції): 23</li>
                        </ul>
                      </div>

                      {/* Deputy Search */}
                      <div>
                        <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                          Пошук голосу конкретного депутата
                        </label>
                        <div className="flex gap-2">
                          <input
                          type="text"
                          value={deputySearch}
                          onChange={(e) => setDeputySearch(e.target.value)}
                          placeholder="Введіть ПІБ депутата..."
                          className="flex-1 px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                          <button className="px-4 py-2.5 bg-claude-accent text-white rounded-lg font-medium hover:bg-[#C66345] transition-colors font-sans">
                            Знайти
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  }

                  {activeTab === 'factions' &&
                  <motion.div
                    key="factions"
                    initial={{
                      opacity: 0,
                      y: 10
                    }}
                    animate={{
                      opacity: 1,
                      y: 0
                    }}
                    exit={{
                      opacity: 0,
                      y: -10
                    }}
                    className="space-y-6">

                      {/* Table */}
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead className="bg-claude-bg border-b border-claude-border">
                            <tr>
                              <th className="px-4 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                Фракція
                              </th>
                              <th className="px-4 py-3 text-center text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                За
                              </th>
                              <th className="px-4 py-3 text-center text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                Проти
                              </th>
                              <th className="px-4 py-3 text-center text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                Утрим.
                              </th>
                              <th className="px-4 py-3 text-center text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                Не гол.
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-claude-border">
                            {factionVoting.map((faction, index) =>
                          <motion.tr
                            key={faction.name}
                            initial={{
                              opacity: 0,
                              x: -20
                            }}
                            animate={{
                              opacity: 1,
                              x: 0
                            }}
                            transition={{
                              delay: index * 0.05
                            }}
                            className="hover:bg-claude-bg transition-colors">

                                <td className="px-4 py-3 text-sm font-medium text-claude-text font-sans">
                                  {faction.name}
                                </td>
                                <td className="px-4 py-3 text-sm text-center text-green-600 font-sans font-medium">
                                  {faction.for}
                                </td>
                                <td className="px-4 py-3 text-sm text-center text-red-600 font-sans font-medium">
                                  {faction.against}
                                </td>
                                <td className="px-4 py-3 text-sm text-center text-amber-600 font-sans font-medium">
                                  {faction.abstain}
                                </td>
                                <td className="px-4 py-3 text-sm text-center text-gray-600 font-sans font-medium">
                                  {faction.notVoted}
                                </td>
                              </motion.tr>
                          )}
                          </tbody>
                        </table>
                      </div>

                      {/* Stacked Bar Chart */}
                      <div>
                        <h4 className="text-sm font-medium text-claude-text font-sans mb-4">
                          Візуалізація по фракціям
                        </h4>
                        <div className="space-y-3">
                          {factionVoting.map((faction, index) => {
                          const forPct = faction.for / faction.total * 100;
                          const againstPct =
                          faction.against / faction.total * 100;
                          const abstainPct =
                          faction.abstain / faction.total * 100;
                          const notVotedPct =
                          faction.notVoted / faction.total * 100;
                          return (
                            <div key={faction.name}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-sm font-medium text-claude-text font-sans">
                                    {faction.name}
                                  </span>
                                  <span className="text-xs text-claude-subtext font-sans">
                                    {faction.total} депутатів
                                  </span>
                                </div>
                                <div className="h-8 bg-gray-100 rounded-lg overflow-hidden flex">
                                  <motion.div
                                  initial={{
                                    width: 0
                                  }}
                                  animate={{
                                    width: `${forPct}%`
                                  }}
                                  transition={{
                                    duration: 0.8,
                                    delay: index * 0.05
                                  }}
                                  className="bg-green-500 hover:bg-green-600 transition-colors cursor-pointer relative group">

                                    <div className="absolute inset-0 flex items-center justify-center text-xs text-white font-sans font-medium opacity-0 group-hover:opacity-100">
                                      {faction.for}
                                    </div>
                                  </motion.div>
                                  <motion.div
                                  initial={{
                                    width: 0
                                  }}
                                  animate={{
                                    width: `${againstPct}%`
                                  }}
                                  transition={{
                                    duration: 0.8,
                                    delay: index * 0.05 + 0.1
                                  }}
                                  className="bg-red-500 hover:bg-red-600 transition-colors cursor-pointer relative group">

                                    <div className="absolute inset-0 flex items-center justify-center text-xs text-white font-sans font-medium opacity-0 group-hover:opacity-100">
                                      {faction.against}
                                    </div>
                                  </motion.div>
                                  <motion.div
                                  initial={{
                                    width: 0
                                  }}
                                  animate={{
                                    width: `${abstainPct}%`
                                  }}
                                  transition={{
                                    duration: 0.8,
                                    delay: index * 0.05 + 0.2
                                  }}
                                  className="bg-amber-500 hover:bg-amber-600 transition-colors cursor-pointer relative group">

                                    <div className="absolute inset-0 flex items-center justify-center text-xs text-white font-sans font-medium opacity-0 group-hover:opacity-100">
                                      {faction.abstain}
                                    </div>
                                  </motion.div>
                                  <motion.div
                                  initial={{
                                    width: 0
                                  }}
                                  animate={{
                                    width: `${notVotedPct}%`
                                  }}
                                  transition={{
                                    duration: 0.8,
                                    delay: index * 0.05 + 0.3
                                  }}
                                  className="bg-gray-400 hover:bg-gray-500 transition-colors cursor-pointer relative group">

                                    <div className="absolute inset-0 flex items-center justify-center text-xs text-white font-sans font-medium opacity-0 group-hover:opacity-100">
                                      {faction.notVoted}
                                    </div>
                                  </motion.div>
                                </div>
                              </div>);

                        })}
                        </div>
                        <div className="flex items-center justify-center gap-6 mt-4 pt-4 border-t border-claude-border">
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 bg-green-500 rounded"></div>
                            <span className="text-xs text-claude-subtext font-sans">
                              За
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 bg-red-500 rounded"></div>
                            <span className="text-xs text-claude-subtext font-sans">
                              Проти
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 bg-amber-500 rounded"></div>
                            <span className="text-xs text-claude-subtext font-sans">
                              Утрималися
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 bg-gray-400 rounded"></div>
                            <span className="text-xs text-claude-subtext font-sans">
                              Не голосували
                            </span>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  }

                  {activeTab === 'regions' &&
                  <motion.div
                    key="regions"
                    initial={{
                      opacity: 0,
                      y: 10
                    }}
                    animate={{
                      opacity: 1,
                      y: 0
                    }}
                    exit={{
                      opacity: 0,
                      y: -10
                    }}
                    className="space-y-6">

                      <div className="bg-claude-bg rounded-xl border border-claude-border p-6">
                        <div className="flex items-center gap-2 mb-4">
                          <MapPin size={20} className="text-claude-accent" />
                          <h4 className="text-sm font-medium text-claude-text font-sans">
                            Карта голосувань по регіонах
                          </h4>
                        </div>
                        <div className="aspect-video bg-white rounded-lg border border-claude-border flex items-center justify-center">
                          <p className="text-claude-subtext font-sans text-sm">
                            Інтерактивна карта України
                          </p>
                        </div>
                        <div className="flex items-center justify-center gap-4 mt-4">
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 bg-green-500 rounded"></div>
                            <span className="text-xs text-claude-subtext font-sans">
                              80-100% "За"
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 bg-amber-500 rounded"></div>
                            <span className="text-xs text-claude-subtext font-sans">
                              50-80% "За"
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 bg-orange-500 rounded"></div>
                            <span className="text-xs text-claude-subtext font-sans">
                              20-50% "За"
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 bg-red-500 rounded"></div>
                            <span className="text-xs text-claude-subtext font-sans">
                              0-20% "За"
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead className="bg-claude-bg border-b border-claude-border">
                            <tr>
                              <th className="px-4 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                Область
                              </th>
                              <th className="px-4 py-3 text-center text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                Депутатів
                              </th>
                              <th className="px-4 py-3 text-center text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                За
                              </th>
                              <th className="px-4 py-3 text-center text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                Проти
                              </th>
                              <th className="px-4 py-3 text-center text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                Утрим.
                              </th>
                              <th className="px-4 py-3 text-center text-xs font-medium text-claude-subtext uppercase tracking-wider font-sans">
                                % "За"
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-claude-border">
                            {regionalData.map((region, index) =>
                          <motion.tr
                            key={region.region}
                            initial={{
                              opacity: 0,
                              x: -20
                            }}
                            animate={{
                              opacity: 1,
                              x: 0
                            }}
                            transition={{
                              delay: index * 0.05
                            }}
                            className="hover:bg-claude-bg transition-colors">

                                <td className="px-4 py-3 text-sm font-medium text-claude-text font-sans">
                                  {region.region}
                                </td>
                                <td className="px-4 py-3 text-sm text-center text-claude-text font-sans">
                                  {region.deputies}
                                </td>
                                <td className="px-4 py-3 text-sm text-center text-green-600 font-sans font-medium">
                                  {region.for}
                                </td>
                                <td className="px-4 py-3 text-sm text-center text-red-600 font-sans font-medium">
                                  {region.against}
                                </td>
                                <td className="px-4 py-3 text-sm text-center text-amber-600 font-sans font-medium">
                                  {region.abstain}
                                </td>
                                <td className="px-4 py-3 text-sm text-center font-sans">
                                  <span
                                className={`inline-flex items-center px-2 py-1 rounded font-medium ${region.percentage >= 80 ? 'bg-green-100 text-green-700' : region.percentage >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>

                                    {region.percentage}%
                                  </span>
                                </td>
                              </motion.tr>
                          )}
                          </tbody>
                        </table>
                      </div>
                    </motion.div>
                  }

                  {activeTab === 'history' &&
                  <motion.div
                    key="history"
                    initial={{
                      opacity: 0,
                      y: 10
                    }}
                    animate={{
                      opacity: 1,
                      y: 0
                    }}
                    exit={{
                      opacity: 0,
                      y: -10
                    }}
                    className="space-y-6">

                      <div className="text-center mb-6">
                        <p className="text-sm text-claude-subtext font-sans mb-4">
                          Законопроект №8234-IX пройшов 4 голосування
                        </p>
                        <div className="flex items-center justify-center gap-2">
                          {votingHistory.map((vote, index) =>
                        <Fragment key={vote.id}>
                              <motion.div
                            initial={{
                              scale: 0
                            }}
                            animate={{
                              scale: 1
                            }}
                            transition={{
                              delay: index * 0.1
                            }}
                            className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold font-sans ${vote.result === 'approved' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>

                                {vote.id}
                              </motion.div>
                              {index < votingHistory.length - 1 &&
                          <div className="w-12 h-0.5 bg-claude-border"></div>
                          }
                            </Fragment>
                        )}
                        </div>
                      </div>

                      <div className="space-y-4">
                        {votingHistory.map((vote, index) =>
                      <motion.div
                        key={vote.id}
                        initial={{
                          opacity: 0,
                          y: 20
                        }}
                        animate={{
                          opacity: 1,
                          y: 0
                        }}
                        transition={{
                          delay: index * 0.1
                        }}
                        className="bg-white rounded-xl border border-claude-border p-4">

                            <div className="flex items-start justify-between mb-3">
                              <div className="flex items-center gap-3">
                                {vote.result === 'approved' ?
                            <CheckCircle
                              size={24}
                              className="text-green-600" /> :


                            <XCircle size={24} className="text-red-600" />
                            }
                                <div>
                                  <h4 className="text-base font-serif font-medium text-claude-text">
                                    {vote.type}
                                  </h4>
                                  <p className="text-sm text-claude-subtext font-sans">
                                    {vote.date}
                                  </p>
                                </div>
                              </div>
                            </div>
                            <div className="grid grid-cols-4 gap-2 mb-3">
                              <div className="text-center p-2 bg-green-50 rounded">
                                <p className="text-xs text-green-700 font-sans">
                                  За
                                </p>
                                <p className="text-lg font-serif font-bold text-green-700">
                                  {vote.for}
                                </p>
                              </div>
                              <div className="text-center p-2 bg-red-50 rounded">
                                <p className="text-xs text-red-700 font-sans">
                                  Проти
                                </p>
                                <p className="text-lg font-serif font-bold text-red-700">
                                  {vote.against}
                                </p>
                              </div>
                              <div className="text-center p-2 bg-amber-50 rounded">
                                <p className="text-xs text-amber-700 font-sans">
                                  Утрим.
                                </p>
                                <p className="text-lg font-serif font-bold text-amber-700">
                                  {vote.abstain}
                                </p>
                              </div>
                              <div className="text-center p-2 bg-gray-50 rounded">
                                <p className="text-xs text-gray-700 font-sans">
                                  Не гол.
                                </p>
                                <p className="text-lg font-serif font-bold text-gray-700">
                                  {vote.notVoted}
                                </p>
                              </div>
                            </div>
                            {vote.result === 'rejected' &&
                        <div className="flex items-center gap-2 p-2 bg-red-50 rounded text-sm text-red-700 font-sans">
                                <AlertCircle size={16} />
                                Не набрано необхідної кількості
                              </div>
                        }
                            <div className="flex gap-2 mt-3">
                              <button className="px-3 py-1.5 text-xs font-medium font-sans text-claude-text bg-claude-bg hover:bg-claude-border rounded-lg transition-colors">
                                Деталі
                              </button>
                              <button className="px-3 py-1.5 text-xs font-medium font-sans text-claude-text bg-claude-bg hover:bg-claude-border rounded-lg transition-colors">
                                Порівняти
                              </button>
                            </div>
                          </motion.div>
                      )}
                      </div>

                      <div className="bg-blue-50 rounded-xl border border-blue-200 p-4">
                        <h4 className="text-sm font-medium text-blue-900 font-sans mb-2">
                          Депутати, які змінили позицію
                        </h4>
                        <p className="text-sm text-blue-800 font-sans mb-3">
                          3 спроба → 4 спроба: 67 депутатів
                        </p>
                        <div className="flex gap-2">
                          <button className="px-3 py-1.5 text-xs font-medium font-sans text-blue-700 bg-white hover:bg-blue-100 rounded-lg transition-colors">
                            Показати список
                          </button>
                          <button className="px-3 py-1.5 text-xs font-medium font-sans text-blue-700 bg-white hover:bg-blue-100 rounded-lg transition-colors">
                            Аналіз причин
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  }
                </AnimatePresence>
              </div>
            </div>

            {/* Export Button */}
            <button className="flex items-center gap-2 px-4 py-2 bg-claude-accent text-white rounded-xl text-sm font-medium font-sans hover:bg-[#C66345] transition-colors shadow-sm">
              <Download size={16} />
              Експорт
            </button>
          </motion.div>
        </div>
      </div>);

  }
  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
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
            duration: 0.5,
            ease: [0.22, 1, 0.36, 1]
          }}>

          <div className="flex items-center gap-4 mb-6">
            {onBack &&
            <button
              onClick={onBack}
              className="p-2 hover:bg-white rounded-lg transition-colors border border-claude-border">

                <ArrowLeft size={20} className="text-claude-text" />
              </button>
            }
            <div>
              <div className="flex items-center gap-3 mb-2">
                <Vote size={32} className="text-claude-accent" />
                <h1 className="text-3xl md:text-4xl font-sans text-claude-text font-medium tracking-tight">
                  Аналіз голосувань
                </h1>
              </div>
              <p className="text-claude-subtext font-sans text-sm">
                Детальний аналіз голосувань по важливих законопроектах
              </p>
            </div>
          </div>

          {/* Search */}
          <div className="bg-white rounded-2xl border border-claude-border shadow-sm p-6 space-y-6">
            <div>
              <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                Знайдіть законопроект
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1 group">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Search className="h-5 w-5 text-claude-subtext group-focus-within:text-claude-accent transition-colors" />
                  </div>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Введіть номер або назву законопроекту..."
                    className="block w-full pl-11 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all shadow-sm font-sans" />

                </div>
                <button
                  onClick={() => setSelectedBill(true)}
                  className="px-6 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans">

                  <Search size={18} />
                </button>
              </div>
            </div>

            {/* Quick Access */}
            <div>
              <h3 className="text-sm font-medium text-claude-text font-sans mb-3">
                Швидкий доступ до важливих законопроектів
              </h3>
              <div className="space-y-2">
                {quickAccessBills.map((bill, index) =>
                <motion.button
                  key={bill}
                  initial={{
                    opacity: 0,
                    x: -20
                  }}
                  animate={{
                    opacity: 1,
                    x: 0
                  }}
                  transition={{
                    delay: index * 0.05
                  }}
                  onClick={() => setSelectedBill(true)}
                  className="w-full text-left px-4 py-3 bg-claude-bg hover:bg-claude-border border border-claude-border rounded-xl transition-all font-sans text-sm text-claude-text">

                    • {bill}
                  </motion.button>
                )}
              </div>
            </div>

            {/* Filters */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-claude-border">
              <div>
                <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                  Тип голосування
                </label>
                <select
                  value={votingType}
                  onChange={(e) => setVotingType(e.target.value)}
                  className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                  <option value="all">Усі</option>
                  <option value="first">1-ше читання</option>
                  <option value="second">2-ге читання</option>
                  <option value="basis">Основа</option>
                  <option value="whole">В цілому</option>
                  <option value="repeat">Повторне</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                  Результат
                </label>
                <select
                  value={resultFilter}
                  onChange={(e) => setResultFilter(e.target.value)}
                  className="w-full px-4 py-2.5 bg-white border border-claude-border rounded-lg text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans">

                  <option value="all">Усі</option>
                  <option value="approved">Прийнято</option>
                  <option value="not-approved">Не прийнято</option>
                  <option value="rejected">Відхилено</option>
                </select>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>);

}