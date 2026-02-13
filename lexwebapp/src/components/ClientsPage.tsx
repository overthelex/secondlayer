import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Search,
  Users,
  ChevronRight,
  Mail,
  Building2,
  Calendar,
  Plus,
  Edit3,
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  AlertCircle,
  Loader2,
  User,
  Landmark,
  Hash,
} from 'lucide-react';
import { clientService } from '../services/api/ClientService';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import type { Client, ClientType, CreateClientRequest, UpdateClientRequest } from '../types/models/Client';

interface ClientsPageProps {
  onSelectClient?: (client: Client) => void;
}

const CLIENT_TYPE_LABELS: Record<ClientType, string> = {
  individual: 'Фіз. особа',
  business: 'Юр. особа',
  government: 'Державна',
};

const CLIENT_TYPE_ICONS: Record<ClientType, React.ReactNode> = {
  individual: <User size={14} />,
  business: <Building2 size={14} />,
  government: <Landmark size={14} />,
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  inactive: 'bg-gray-100 text-gray-600',
  archived: 'bg-amber-100 text-amber-700',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Активний',
  inactive: 'Неактивний',
  archived: 'Архів',
};

const CONFLICT_ICONS: Record<string, React.ReactNode> = {
  unchecked: <Shield size={14} className="text-gray-400" />,
  clear: <ShieldCheck size={14} className="text-green-500" />,
  flagged: <ShieldAlert size={14} className="text-amber-500" />,
  conflicted: <ShieldX size={14} className="text-red-500" />,
};

const CONFLICT_LABELS: Record<string, string> = {
  unchecked: 'Не перевірено',
  clear: 'Чисто',
  flagged: 'Під увагою',
  conflicted: 'Конфлікт',
};

const PAGE_SIZE = 20;

type FilterType = 'all' | 'individual' | 'business' | 'government';

export function ClientsPage({ onSelectClient }: ClientsPageProps) {
  const [clients, setClients] = useState<Client[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [offset, setOffset] = useState(0);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<ClientType>('individual');
  const [formEmail, setFormEmail] = useState('');
  const [formTaxId, setFormTaxId] = useState('');

  const fetchClients = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await clientService.getClients({
        search: searchQuery || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setClients(result.clients);
      setTotal(result.total);
    } catch (err: any) {
      setError(err.message || 'Не вдалося завантажити клієнтів');
    } finally {
      setLoading(false);
    }
  }, [searchQuery, offset]);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  // Reset offset when search changes
  useEffect(() => {
    setOffset(0);
  }, [searchQuery]);

  // Client-side type filtering (backend doesn't have type filter param)
  const filteredClients = filterType === 'all'
    ? clients
    : clients.filter((c) => c.client_type === filterType);

  // Stats from loaded clients
  const stats = {
    total,
    active: clients.filter((c) => c.status === 'active').length,
    individual: clients.filter((c) => c.client_type === 'individual').length,
    business: clients.filter((c) => c.client_type === 'business').length,
    government: clients.filter((c) => c.client_type === 'government').length,
  };

  const openAddModal = () => {
    setEditingClient(null);
    setFormName('');
    setFormType('individual');
    setFormEmail('');
    setFormTaxId('');
    setShowModal(true);
  };

  const openEditModal = (client: Client, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingClient(client);
    setFormName(client.client_name);
    setFormType(client.client_type);
    setFormEmail(client.contact_email || '');
    setFormTaxId(client.tax_id || '');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) return;

    setSaving(true);
    try {
      if (editingClient) {
        const data: UpdateClientRequest = {
          clientName: formName.trim(),
          clientType: formType,
          contactEmail: formEmail.trim() || undefined,
          taxId: formTaxId.trim() || undefined,
        };
        await clientService.updateClient(editingClient.id, data);
      } else {
        const data: CreateClientRequest = {
          clientName: formName.trim(),
          clientType: formType,
          contactEmail: formEmail.trim() || undefined,
          taxId: formTaxId.trim() || undefined,
        };
        await clientService.createClient(data);
      }
      setShowModal(false);
      fetchClients();
    } catch (err: any) {
      // Error toast is handled by api-client interceptor
    } finally {
      setSaving(false);
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  const hasMore = offset + PAGE_SIZE < total;
  const hasPrev = offset > 0;

  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-4"
        >
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight mb-2">
                Клієнти
              </h1>
              <p className="text-claude-subtext font-sans text-sm">
                Управління клієнтською базою та профілями
              </p>
            </div>

            <button
              onClick={openAddModal}
              className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors shadow-sm active:scale-[0.98]"
            >
              <Plus size={18} />
              Додати клієнта
            </button>
          </div>

          {/* Stats */}
          <div className="flex flex-wrap gap-3 text-sm font-sans">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <span className="text-claude-subtext">Всього:</span>
              <span className="font-serif font-medium text-claude-text">{stats.total}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <span className="text-green-600">Активних:</span>
              <span className="font-serif font-medium text-green-600">{stats.active}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <User size={14} className="text-claude-subtext" />
              <span className="font-serif font-medium text-claude-text">{stats.individual}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <Building2 size={14} className="text-claude-subtext" />
              <span className="font-serif font-medium text-claude-text">{stats.business}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <Landmark size={14} className="text-claude-subtext" />
              <span className="font-serif font-medium text-claude-text">{stats.government}</span>
            </div>
          </div>

          {/* Search + Filter */}
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1 group">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-claude-subtext group-focus-within:text-claude-accent transition-colors" />
              </div>
              <input
                type="text"
                className="block w-full pl-11 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all shadow-sm font-sans"
                placeholder="Пошук за ім'ям клієнта..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="flex gap-2">
              {([
                ['all', 'Всі'],
                ['individual', 'Фіз. особи'],
                ['business', 'Юр. особи'],
                ['government', 'Державні'],
              ] as [FilterType, string][]).map(([type, label]) => (
                <button
                  key={type}
                  onClick={() => setFilterType(type)}
                  className={`px-4 py-3 rounded-xl font-medium text-sm font-sans transition-all ${
                    filterType === type
                      ? 'bg-claude-accent text-white shadow-sm'
                      : 'bg-white text-claude-text border border-claude-border hover:bg-claude-bg'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-16">
            <Spinner size="lg" />
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700"
          >
            <AlertCircle size={20} />
            <span className="font-sans text-sm">{error}</span>
            <button
              onClick={fetchClients}
              className="ml-auto text-sm font-medium underline hover:no-underline"
            >
              Спробувати знову
            </button>
          </motion.div>
        )}

        {/* Client List */}
        {!loading && !error && (
          <div className="space-y-3">
            {filteredClients.map((client, index) => (
              <motion.div
                key={client.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: index * 0.03 + 0.2 }}
                onClick={() => onSelectClient?.(client)}
                className="group bg-white rounded-2xl p-5 border border-claude-border shadow-sm hover:shadow-md hover:border-claude-subtext/30 transition-all cursor-pointer relative"
              >
                <div className="flex items-start gap-4">
                  {/* Avatar */}
                  <div className="w-12 h-12 rounded-full bg-claude-sidebar border-2 border-white shadow-sm flex items-center justify-center text-lg font-serif text-claude-subtext flex-shrink-0 relative">
                    {getInitials(client.client_name)}
                    <div
                      className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white ${
                        client.status === 'active' ? 'bg-green-500' : client.status === 'archived' ? 'bg-amber-500' : 'bg-gray-400'
                      }`}
                    />
                  </div>

                  {/* Main Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-4 mb-2">
                      <div>
                        <h3 className="text-lg font-serif font-medium text-claude-text group-hover:text-claude-accent transition-colors">
                          {client.client_name}
                        </h3>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[client.status] || 'bg-gray-100 text-gray-600'}`}>
                            {STATUS_LABELS[client.status] || client.status}
                          </span>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                            {CLIENT_TYPE_ICONS[client.client_type]}
                            {CLIENT_TYPE_LABELS[client.client_type] || client.client_type}
                          </span>
                          <span className="inline-flex items-center gap-1 text-xs text-claude-subtext">
                            {CONFLICT_ICONS[client.conflict_status]}
                            {CONFLICT_LABELS[client.conflict_status] || client.conflict_status}
                          </span>
                        </div>
                      </div>

                      <button
                        onClick={(e) => openEditModal(client, e)}
                        className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                        title="Редагувати"
                      >
                        <Edit3 size={18} />
                      </button>
                    </div>

                    {/* Contact Info */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
                      {client.contact_email && (
                        <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
                          <Mail size={14} className="flex-shrink-0" />
                          <span className="truncate">{client.contact_email}</span>
                        </div>
                      )}
                      {client.tax_id && (
                        <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
                          <Hash size={14} className="flex-shrink-0" />
                          <span>{client.tax_id}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
                        <Calendar size={14} className="flex-shrink-0" />
                        <span>
                          {new Date(client.created_at).toLocaleDateString('uk-UA')}
                        </span>
                      </div>
                    </div>

                    {/* Bottom action row */}
                    <div className="flex items-center gap-2 mt-4 pt-4 border-t border-claude-border/50">
                      <button
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-sans text-claude-accent hover:bg-claude-accent/10 rounded-lg transition-colors ml-auto"
                      >
                        Відкрити профіль
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && filteredClients.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12"
          >
            <div className="w-16 h-16 bg-claude-bg rounded-full flex items-center justify-center mx-auto mb-4 text-claude-subtext">
              {clients.length === 0 ? <Users size={24} /> : <Search size={24} />}
            </div>
            <h3 className="text-lg font-serif text-claude-text mb-2">
              {clients.length === 0 ? 'Клієнтів ще немає' : 'Клієнтів не знайдено'}
            </h3>
            <p className="text-claude-subtext font-sans max-w-md mx-auto">
              {clients.length === 0
                ? 'Додайте першого клієнта для початку роботи'
                : 'Спробуйте змінити параметри пошуку або фільтри'}
            </p>
            {clients.length === 0 && (
              <button
                onClick={openAddModal}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors"
              >
                <Plus size={18} />
                Додати клієнта
              </button>
            )}
          </motion.div>
        )}

        {/* Pagination */}
        {!loading && !error && total > PAGE_SIZE && (
          <div className="flex items-center justify-between pt-4">
            <span className="text-sm text-claude-subtext font-sans">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} з {total}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                disabled={!hasPrev}
                className="px-4 py-2 rounded-xl text-sm font-sans font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-white border border-claude-border text-claude-text hover:bg-claude-bg"
              >
                Назад
              </button>
              <button
                onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
                disabled={!hasMore}
                className="px-4 py-2 rounded-xl text-sm font-sans font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-white border border-claude-border text-claude-text hover:bg-claude-bg"
              >
                Далі
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editingClient ? 'Редагувати клієнта' : 'Новий клієнт'}
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-4 p-1">
          {/* Client Name */}
          <div>
            <label className="block text-sm font-medium text-claude-text font-sans mb-1">
              Ім'я / Назва <span className="text-red-500">*</span>
            </label>
            <input
              id="client-name"
              name="clientName"
              type="text"
              required
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Прізвище Ім'я По-батькові або назва організації"
              className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans text-sm"
            />
          </div>

          {/* Client Type */}
          <div>
            <label className="block text-sm font-medium text-claude-text font-sans mb-1">
              Тип клієнта
            </label>
            <div className="flex gap-2">
              {(['individual', 'business', 'government'] as ClientType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setFormType(type)}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-sans font-medium transition-all ${
                    formType === type
                      ? 'bg-claude-accent text-white shadow-sm'
                      : 'bg-white text-claude-text border border-claude-border hover:bg-claude-bg'
                  }`}
                >
                  {CLIENT_TYPE_ICONS[type]}
                  {CLIENT_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          </div>

          {/* Email */}
          <div>
            <label className="block text-sm font-medium text-claude-text font-sans mb-1">
              Email
            </label>
            <input
              id="client-email"
              name="clientEmail"
              type="email"
              value={formEmail}
              onChange={(e) => setFormEmail(e.target.value)}
              placeholder="client@example.com"
              className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans text-sm"
            />
          </div>

          {/* Tax ID */}
          <div>
            <label className="block text-sm font-medium text-claude-text font-sans mb-1">
              Код ЄДРПОУ / ІПН
            </label>
            <input
              id="client-tax-id"
              name="taxId"
              type="text"
              value={formTaxId}
              onChange={(e) => setFormTaxId(e.target.value)}
              placeholder="12345678"
              className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans text-sm"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowModal(false)}
              className="flex-1 px-4 py-2.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium text-sm font-sans hover:bg-claude-bg transition-colors"
            >
              Скасувати
            </button>
            <button
              type="submit"
              disabled={saving || !formName.trim()}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              {editingClient ? 'Зберегти' : 'Створити'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
