/**
 * Matter Detail Page Component
 * Tabbed layout: overview, team, holds, documents, activity
 */

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Briefcase,
  Users,
  Shield,
  FileText,
  Clock,
  Edit3,
  Building2,
  User,
  Gavel,
  Calendar,
  Lock,
  Loader2,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useClientMatterStore } from '../stores/clientMatterStore';
import { useMatterTeam, useAddTeamMember, useRemoveTeamMember, useCloseMatter } from '../hooks/queries/useMatters';
import { useClient } from '../hooks/queries/useClients';
import { HoldsList } from './matters/HoldsList';
import { AuditLogViewer } from './audit/AuditLogViewer';
import { generateRoute } from '../router/routes';
import type { Matter, MatterTeamRole, MatterAccessLevel } from '../types/models/Matter';

interface MatterDetailPageProps {
  matter: Matter;
  onBack: () => void;
}

const MATTER_TYPE_LABELS: Record<string, string> = {
  litigation: 'Судовий процес',
  advisory: 'Консультування',
  transactional: 'Транзакційна',
  regulatory: 'Регуляторна',
  arbitration: 'Арбітраж',
  other: 'Інше',
};

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  open: { label: 'Відкрита', color: 'bg-blue-100 text-blue-700' },
  active: { label: 'Активна', color: 'bg-green-100 text-green-700' },
  closed: { label: 'Закрита', color: 'bg-gray-100 text-gray-600' },
  archived: { label: 'Архів', color: 'bg-amber-100 text-amber-700' },
};

const ROLE_LABELS: Record<string, string> = {
  lead_attorney: 'Головний адвокат',
  associate: 'Асоціат',
  paralegal: 'Паралегал',
  counsel: 'Консультант',
  admin: 'Адміністратор',
  observer: 'Спостерігач',
};

const ROLE_COLORS: Record<string, string> = {
  lead_attorney: 'bg-purple-100 text-purple-700',
  associate: 'bg-blue-100 text-blue-700',
  paralegal: 'bg-teal-100 text-teal-700',
  counsel: 'bg-indigo-100 text-indigo-700',
  admin: 'bg-gray-100 text-gray-700',
  observer: 'bg-gray-100 text-gray-500',
};

type Tab = 'overview' | 'team' | 'holds' | 'documents' | 'activity';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Огляд', icon: <Briefcase size={16} /> },
  { id: 'team', label: 'Команда', icon: <Users size={16} /> },
  { id: 'holds', label: 'Утримання', icon: <Lock size={16} /> },
  { id: 'documents', label: 'Документи', icon: <FileText size={16} /> },
  { id: 'activity', label: 'Активність', icon: <Clock size={16} /> },
];

export function MatterDetailPage({ matter, onBack }: MatterDetailPageProps) {
  const navigate = useNavigate();
  const { matterDetailTab, setMatterDetailTab } = useClientMatterStore();
  const closeMatter = useCloseMatter();

  const { data: teamData } = useMatterTeam(matter.id);
  const { data: clientData } = useClient(matter.client_id);
  const removeTeamMember = useRemoveTeamMember();
  const addTeamMember = useAddTeamMember();

  const [addMemberId, setAddMemberId] = useState('');
  const [addMemberRole, setAddMemberRole] = useState<MatterTeamRole>('associate');

  const team = teamData?.members || [];
  const statusConfig = STATUS_CONFIG[matter.status] || STATUS_CONFIG.open;
  const activeTab = matterDetailTab as Tab;

  const handleClose = async () => {
    if (window.confirm('Ви впевнені, що хочете закрити цю справу?')) {
      try {
        await closeMatter.mutateAsync(matter.id);
      } catch {
        // Error handled by mutation
      }
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addMemberId.trim()) return;
    try {
      await addTeamMember.mutateAsync({
        matterId: matter.id,
        memberId: addMemberId.trim(),
        role: addMemberRole,
      });
      setAddMemberId('');
    } catch {
      // Error handled
    }
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Back */}
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-claude-subtext hover:text-claude-text transition-colors group"
        >
          <ArrowLeft size={18} className="group-hover:-translate-x-1 transition-transform" />
          <span className="font-sans text-sm">Назад до списку справ</span>
        </button>

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="bg-white rounded-2xl p-6 md:p-8 border border-claude-border shadow-sm"
        >
          <div className="flex flex-col md:flex-row items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-mono text-claude-subtext">{matter.matter_number}</span>
                <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium ${statusConfig.color}`}>
                  {statusConfig.label}
                </span>
                {matter.has_legal_hold && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-100 text-red-700">
                    <Shield size={12} />
                    Утримання
                  </span>
                )}
              </div>
              <h1 className="text-2xl md:text-3xl font-serif text-claude-text font-medium tracking-tight">
                {matter.matter_name}
              </h1>

              {/* Client link */}
              {clientData && (
                <button
                  onClick={() => navigate(generateRoute.clientDetail(matter.client_id))}
                  className="flex items-center gap-2 mt-2 text-sm text-claude-accent font-sans hover:underline"
                >
                  <Building2 size={14} />
                  {clientData.client_name}
                </button>
              )}
            </div>

            <div className="flex gap-2">
              {(matter.status === 'open' || matter.status === 'active') && (
                <button
                  onClick={handleClose}
                  disabled={closeMatter.isPending}
                  className="flex items-center gap-2 px-3 py-2 text-sm font-sans font-medium text-gray-700 bg-white border border-claude-border rounded-xl hover:bg-claude-bg transition-colors disabled:opacity-50"
                >
                  {closeMatter.isPending ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                  Закрити справу
                </button>
              )}
            </div>
          </div>
        </motion.div>

        {/* Tabs */}
        <div className="flex gap-1 bg-white rounded-xl border border-claude-border p-1 shadow-sm overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setMatterDetailTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-sans font-medium transition-all whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-claude-accent text-white shadow-sm'
                  : 'text-claude-subtext hover:text-claude-text hover:bg-claude-bg'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.id === 'team' && team.length > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === 'team' ? 'bg-white/20' : 'bg-claude-subtext/10'}`}>
                  {team.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <motion.div key={activeTab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Details */}
              <div className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
                <h2 className="text-xl font-serif text-claude-text mb-4">Деталі справи</h2>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                    <span className="text-sm text-claude-subtext font-sans">Тип</span>
                    <span className="text-sm font-medium text-claude-text font-sans">
                      {MATTER_TYPE_LABELS[matter.matter_type] || matter.matter_type}
                    </span>
                  </div>
                  {matter.responsible_attorney && (
                    <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                      <span className="text-sm text-claude-subtext font-sans">Відповідальний</span>
                      <span className="text-sm font-medium text-claude-text font-sans flex items-center gap-2">
                        <User size={14} />
                        {matter.responsible_attorney}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                    <span className="text-sm text-claude-subtext font-sans">Дата відкриття</span>
                    <span className="text-sm font-medium text-claude-text font-sans flex items-center gap-2">
                      <Calendar size={14} />
                      {new Date(matter.opened_date).toLocaleDateString('uk-UA')}
                    </span>
                  </div>
                  {matter.closed_date && (
                    <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                      <span className="text-sm text-claude-subtext font-sans">Дата закриття</span>
                      <span className="text-sm font-medium text-claude-text font-sans">
                        {new Date(matter.closed_date).toLocaleDateString('uk-UA')}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                    <span className="text-sm text-claude-subtext font-sans">Строк зберігання</span>
                    <span className="text-sm font-medium text-claude-text font-sans">
                      {matter.retention_period_years} р.
                    </span>
                  </div>
                </div>
              </div>

              {/* Court & Parties */}
              <div className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
                <h2 className="text-xl font-serif text-claude-text mb-4">Суд та сторони</h2>
                <div className="space-y-4">
                  {matter.court_name && (
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext"><Gavel size={18} /></div>
                      <div>
                        <div className="text-xs text-claude-subtext font-sans mb-1">Суд</div>
                        <p className="text-sm text-claude-text font-sans">{matter.court_name}</p>
                      </div>
                    </div>
                  )}
                  {matter.court_case_number && (
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext"><FileText size={18} /></div>
                      <div>
                        <div className="text-xs text-claude-subtext font-sans mb-1">Номер справи в суді</div>
                        <p className="text-sm text-claude-text font-sans font-mono">{matter.court_case_number}</p>
                      </div>
                    </div>
                  )}
                  {matter.opposing_party && (
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext"><Users size={18} /></div>
                      <div>
                        <div className="text-xs text-claude-subtext font-sans mb-1">Протилежна сторона</div>
                        <p className="text-sm text-claude-text font-sans">{matter.opposing_party}</p>
                      </div>
                    </div>
                  )}
                  {matter.related_parties && matter.related_parties.length > 0 && (
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext"><Users size={18} /></div>
                      <div>
                        <div className="text-xs text-claude-subtext font-sans mb-1">Пов'язані сторони</div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {matter.related_parties.map((party, i) => (
                            <span key={i} className="px-2 py-0.5 bg-claude-bg rounded text-xs font-sans text-claude-text">{party}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {!matter.court_name && !matter.court_case_number && !matter.opposing_party && (
                    <p className="text-sm text-claude-subtext font-sans">Інформація про суд не заповнена</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'team' && (
            <div className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-serif text-claude-text">Команда справи</h2>
              </div>

              {/* Add member form */}
              <form onSubmit={handleAddMember} className="flex gap-2 mb-6 p-4 bg-claude-bg rounded-xl">
                <input
                  type="text"
                  value={addMemberId}
                  onChange={(e) => setAddMemberId(e.target.value)}
                  placeholder="ID учасника"
                  className="flex-1 px-3 py-2 bg-white border border-claude-border rounded-lg text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20"
                />
                <select
                  value={addMemberRole}
                  onChange={(e) => setAddMemberRole(e.target.value as MatterTeamRole)}
                  className="px-3 py-2 bg-white border border-claude-border rounded-lg text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20"
                >
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={addTeamMember.isPending || !addMemberId.trim()}
                  className="flex items-center gap-1 px-3 py-2 bg-claude-accent text-white rounded-lg text-sm font-sans font-medium hover:bg-[#C66345] transition-colors disabled:opacity-50"
                >
                  {addTeamMember.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  Додати
                </button>
              </form>

              {/* Team list */}
              {team.length === 0 ? (
                <div className="text-center py-8">
                  <Users size={24} className="mx-auto text-claude-subtext mb-2" />
                  <p className="text-claude-subtext font-sans text-sm">Учасників ще немає</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {team.map((member, index) => {
                    const roleColor = ROLE_COLORS[member.role] || ROLE_COLORS.observer;
                    return (
                      <motion.div
                        key={member.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.05 }}
                        className="flex items-center justify-between p-3 border border-claude-border/50 rounded-xl hover:bg-claude-bg/50 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-claude-sidebar flex items-center justify-center text-sm font-serif text-claude-subtext">
                            {(member.user_name || member.user_id).slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="text-sm font-medium text-claude-text font-sans">
                              {member.user_name || member.user_id}
                            </div>
                            {member.user_email && (
                              <div className="text-xs text-claude-subtext font-sans">{member.user_email}</div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${roleColor}`}>
                            {ROLE_LABELS[member.role] || member.role}
                          </span>
                          <button
                            onClick={() => removeTeamMember.mutate({ matterId: matter.id, userId: member.user_id })}
                            className="p-1.5 text-claude-subtext hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                            title="Видалити"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'holds' && (
            <div className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
              <HoldsList matterId={matter.id} />
            </div>
          )}

          {activeTab === 'documents' && (
            <div className="text-center py-12 bg-white rounded-2xl border border-claude-border shadow-sm">
              <FileText size={32} className="mx-auto text-claude-subtext mb-3" />
              <h3 className="text-lg font-serif text-claude-text mb-1">Документи справи</h3>
              <p className="text-claude-subtext font-sans text-sm">
                Документи будуть відображатися тут після завантаження
              </p>
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
              <h2 className="text-xl font-serif text-claude-text mb-4">Історія дій</h2>
              <AuditLogViewer resourceType="matter" resourceId={matter.id} />
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
