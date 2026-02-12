/**
 * Client Detail Page Component
 * Tabbed layout: overview, matters, documents, activity, compliance
 */

import React from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Mail,
  Phone,
  MapPin,
  Calendar,
  Edit3,
  Building2,
  User,
  Landmark,
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Briefcase,
  Plus,
  FileText,
  Clock,
  Hash,
  CheckCircle,
} from 'lucide-react';
import { useClientMatterStore } from '../stores/clientMatterStore';
import { useMatters } from '../hooks/queries/useMatters';
import { ConflictCheckPanel } from './clients/ConflictCheckPanel';
import { AuditLogViewer } from './audit/AuditLogViewer';
import { CreateMatterModal } from './matters/CreateMatterModal';
import { generateRoute } from '../router/routes';
import type { Client } from '../types/models/Client';

interface ClientDetailPageProps {
  client: Client;
  onBack: () => void;
}

const CLIENT_TYPE_LABELS: Record<string, string> = {
  individual: 'Фізична особа',
  business: 'Юридична особа',
  government: 'Державна установа',
};

const CLIENT_TYPE_ICONS: Record<string, React.ReactNode> = {
  individual: <User size={14} />,
  business: <Building2 size={14} />,
  government: <Landmark size={14} />,
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Активний',
  inactive: 'Неактивний',
  archived: 'Архів',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  inactive: 'bg-gray-100 text-gray-600',
  archived: 'bg-amber-100 text-amber-700',
};

const CONFLICT_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  unchecked: { icon: <Shield size={14} />, label: 'Не перевірено', color: 'text-gray-500' },
  clear: { icon: <ShieldCheck size={14} />, label: 'Чисто', color: 'text-green-600' },
  flagged: { icon: <ShieldAlert size={14} />, label: 'Під увагою', color: 'text-amber-600' },
  conflicted: { icon: <ShieldX size={14} />, label: 'Конфлікт', color: 'text-red-600' },
};

type Tab = 'overview' | 'matters' | 'documents' | 'activity' | 'compliance';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Огляд', icon: <User size={16} /> },
  { id: 'matters', label: 'Справи', icon: <Briefcase size={16} /> },
  { id: 'documents', label: 'Документи', icon: <FileText size={16} /> },
  { id: 'activity', label: 'Активність', icon: <Clock size={16} /> },
  { id: 'compliance', label: 'Відповідність', icon: <CheckCircle size={16} /> },
];

export function ClientDetailPage({ client, onBack }: ClientDetailPageProps) {
  const navigate = useNavigate();
  const { clientDetailTab, setClientDetailTab } = useClientMatterStore();
  const [showCreateMatter, setShowCreateMatter] = React.useState(false);
  const [showEditModal, setShowEditModal] = React.useState(false);

  const { data: mattersData } = useMatters({ clientId: client.id, limit: 100 });
  const matters = mattersData?.matters || [];

  const conflict = CONFLICT_CONFIG[client.conflict_status] || CONFLICT_CONFIG.unchecked;
  const metadata = client.metadata || {};

  const getInitials = (name: string) =>
    name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();

  const activeTab = clientDetailTab as Tab;

  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Back Button */}
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-claude-subtext hover:text-claude-text transition-colors group"
        >
          <ArrowLeft size={18} className="group-hover:-translate-x-1 transition-transform" />
          <span className="font-sans text-sm">Назад до списку клієнтів</span>
        </button>

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="relative bg-white rounded-2xl p-6 md:p-8 border border-claude-border shadow-sm overflow-hidden"
        >
          <div className="absolute top-0 left-0 w-full h-32 bg-gradient-to-r from-claude-accent/10 to-claude-bg" />

          <div className="relative flex flex-col md:flex-row items-start md:items-end gap-6 pt-12">
            <div className="w-24 h-24 md:w-28 md:h-28 rounded-full bg-claude-sidebar border-4 border-white shadow-md flex items-center justify-center text-2xl font-serif text-claude-subtext relative">
              {getInitials(client.client_name)}
              <div
                className={`absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-white ${
                  client.status === 'active' ? 'bg-green-500' : client.status === 'archived' ? 'bg-amber-500' : 'bg-gray-400'
                }`}
              />
            </div>

            <div className="flex-1 mb-2">
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight">
                {client.client_name}
              </h1>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium ${STATUS_COLORS[client.status]}`}>
                  {STATUS_LABELS[client.status]}
                </span>
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-50 text-blue-700">
                  {CLIENT_TYPE_ICONS[client.client_type]}
                  {CLIENT_TYPE_LABELS[client.client_type]}
                </span>
                <span className={`inline-flex items-center gap-1 text-xs ${conflict.color}`}>
                  {conflict.icon}
                  {conflict.label}
                </span>
              </div>
            </div>

            <button
              onClick={() => setShowEditModal(true)}
              className="p-2.5 bg-white border border-claude-border rounded-xl text-claude-subtext hover:text-claude-text hover:bg-claude-bg transition-colors"
              title="Редагувати"
            >
              <Edit3 size={18} />
            </button>
          </div>
        </motion.div>

        {/* Tabs */}
        <div className="flex gap-1 bg-white rounded-xl border border-claude-border p-1 shadow-sm overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setClientDetailTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-sans font-medium transition-all whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-claude-accent text-white shadow-sm'
                  : 'text-claude-subtext hover:text-claude-text hover:bg-claude-bg'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.id === 'matters' && matters.length > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                  activeTab === 'matters' ? 'bg-white/20' : 'bg-claude-subtext/10'
                }`}>
                  {matters.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Contact Info */}
              <div className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
                <h2 className="text-xl font-serif text-claude-text mb-4">Контактна інформація</h2>
                <div className="space-y-4">
                  {client.contact_email && (
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext"><Mail size={18} /></div>
                      <div>
                        <div className="text-xs text-claude-subtext font-sans mb-1">Email</div>
                        <a href={`mailto:${client.contact_email}`} className="text-sm text-claude-text font-sans hover:text-claude-accent transition-colors">
                          {client.contact_email}
                        </a>
                      </div>
                    </div>
                  )}
                  {metadata.phone && (
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext"><Phone size={18} /></div>
                      <div>
                        <div className="text-xs text-claude-subtext font-sans mb-1">Телефон</div>
                        <a href={`tel:${metadata.phone}`} className="text-sm text-claude-text font-sans hover:text-claude-accent transition-colors">
                          {metadata.phone}
                        </a>
                      </div>
                    </div>
                  )}
                  {metadata.address && (
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext"><MapPin size={18} /></div>
                      <div>
                        <div className="text-xs text-claude-subtext font-sans mb-1">Адреса</div>
                        <p className="text-sm text-claude-text font-sans">{metadata.address}</p>
                      </div>
                    </div>
                  )}
                  {client.tax_id && (
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext"><Hash size={18} /></div>
                      <div>
                        <div className="text-xs text-claude-subtext font-sans mb-1">ЄДРПОУ / ІПН</div>
                        <p className="text-sm text-claude-text font-sans">{client.tax_id}</p>
                      </div>
                    </div>
                  )}
                  {!client.contact_email && !metadata.phone && !metadata.address && !client.tax_id && (
                    <p className="text-sm text-claude-subtext font-sans">Контактні дані не заповнені</p>
                  )}
                </div>
              </div>

              {/* Stats */}
              <div className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
                <h2 className="text-xl font-serif text-claude-text mb-4">Статистика</h2>
                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                    <span className="text-sm text-claude-subtext font-sans">Справ</span>
                    <span className="text-2xl font-serif text-claude-text">{matters.length}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                    <span className="text-sm text-claude-subtext font-sans">Активних утримань</span>
                    <span className="text-2xl font-serif text-claude-text">
                      {matters.filter((m) => m.has_legal_hold).length}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                    <span className="text-sm text-claude-subtext font-sans">Клієнт з</span>
                    <span className="text-sm font-medium text-claude-text font-sans">
                      {new Date(client.created_at).toLocaleDateString('uk-UA')}
                    </span>
                  </div>
                </div>
              </div>

              {/* Notes */}
              {metadata.notes && (
                <div className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm md:col-span-2">
                  <h2 className="text-xl font-serif text-claude-text mb-3">Нотатки</h2>
                  <p className="text-sm text-claude-text font-sans whitespace-pre-wrap">{metadata.notes}</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'matters' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-serif text-claude-text">Справи клієнта</h2>
                <button
                  onClick={() => setShowCreateMatter(true)}
                  className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors shadow-sm"
                >
                  <Plus size={16} />
                  Створити справу
                </button>
              </div>

              {matters.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-2xl border border-claude-border shadow-sm">
                  <Briefcase size={32} className="mx-auto text-claude-subtext mb-3" />
                  <h3 className="text-lg font-serif text-claude-text mb-1">Справ ще немає</h3>
                  <p className="text-claude-subtext font-sans text-sm">Створіть першу справу для цього клієнта</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {matters.map((matter, index) => (
                    <motion.div
                      key={matter.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.4, delay: index * 0.03 }}
                      onClick={() => navigate(generateRoute.matterDetail(matter.id))}
                      className="group bg-white rounded-xl p-5 border border-claude-border shadow-sm hover:shadow-md hover:border-claude-subtext/30 transition-all cursor-pointer"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-mono text-claude-subtext">{matter.matter_number}</span>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                              matter.status === 'active' || matter.status === 'open'
                                ? 'bg-green-100 text-green-700'
                                : matter.status === 'closed'
                                ? 'bg-gray-100 text-gray-600'
                                : 'bg-amber-100 text-amber-700'
                            }`}>
                              {matter.status === 'open' ? 'Відкрита' : matter.status === 'active' ? 'Активна' : matter.status === 'closed' ? 'Закрита' : 'Архів'}
                            </span>
                            {matter.has_legal_hold && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                                <Shield size={10} />
                                Утримання
                              </span>
                            )}
                          </div>
                          <h3 className="text-base font-serif font-medium text-claude-text group-hover:text-claude-accent transition-colors">
                            {matter.matter_name}
                          </h3>
                          {matter.responsible_attorney && (
                            <div className="text-xs text-claude-subtext font-sans mt-1">
                              Відповідальний: {matter.responsible_attorney}
                            </div>
                          )}
                        </div>
                        <div className="text-xs text-claude-subtext font-sans text-right flex-shrink-0">
                          {new Date(matter.opened_date).toLocaleDateString('uk-UA')}
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'documents' && (
            <div className="text-center py-12 bg-white rounded-2xl border border-claude-border shadow-sm">
              <FileText size={32} className="mx-auto text-claude-subtext mb-3" />
              <h3 className="text-lg font-serif text-claude-text mb-1">Документи клієнта</h3>
              <p className="text-claude-subtext font-sans text-sm">
                Документи будуть відображатися тут після прив'язки до справ
              </p>
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
              <h2 className="text-xl font-serif text-claude-text mb-4">Історія дій</h2>
              <AuditLogViewer resourceType="client" resourceId={client.id} />
            </div>
          )}

          {activeTab === 'compliance' && (
            <div className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
              <h2 className="text-xl font-serif text-claude-text mb-4">Перевірка конфліктів</h2>
              <ConflictCheckPanel
                clientId={client.id}
                conflictStatus={client.conflict_status}
                conflictCheckDate={client.conflict_check_date}
              />
            </div>
          )}
        </motion.div>

        {/* Create Matter Modal */}
        <CreateMatterModal
          isOpen={showCreateMatter}
          onClose={() => setShowCreateMatter(false)}
          clientId={client.id}
          clientName={client.client_name}
        />
      </div>
    </div>
  );
}
