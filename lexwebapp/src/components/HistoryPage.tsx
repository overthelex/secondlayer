import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Search,
  Clock,
  MessageSquare,
  Trash2,
  MoreVertical,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Check,
  X,
} from 'lucide-react';
import { conversationService, Conversation } from '../services/api/ConversationService';
import { useChatStore } from '../stores/chatStore';
import { ROUTES } from '../router/routes';

function groupByDate(items: Conversation[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const thisWeek = new Date(today);
  thisWeek.setDate(thisWeek.getDate() - 7);
  const thisMonth = new Date(today);
  thisMonth.setMonth(thisMonth.getMonth() - 1);

  const groups: Record<string, Conversation[]> = {
    'Сьогодні': [],
    'Вчора': [],
    'Цього тижня': [],
    'Цього місяця': [],
    'Раніше': [],
  };

  items.forEach((item) => {
    const itemDate = new Date(item.updated_at || item.created_at);
    if (itemDate >= today) {
      groups['Сьогодні'].push(item);
    } else if (itemDate >= yesterday) {
      groups['Вчора'].push(item);
    } else if (itemDate >= thisWeek) {
      groups['Цього тижня'].push(item);
    } else if (itemDate >= thisMonth) {
      groups['Цього місяця'].push(item);
    } else {
      groups['Раніше'].push(item);
    }
  });

  return Object.entries(groups).filter(([, items]) => items.length > 0);
}

export function HistoryPage() {
  const navigate = useNavigate();
  const switchConversation = useChatStore((s) => s.switchConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'comfortable' | 'compact'>('comfortable');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  useEffect(() => {
    loadConversations();
  }, []);

  async function loadConversations() {
    setLoading(true);
    try {
      const result = await conversationService.list({ limit: 200, offset: 0 });
      setConversations(result.conversations);
      setTotal(result.total);
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleOpen(conv: Conversation) {
    await switchConversation(conv.id);
    navigate(ROUTES.CHAT);
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setMenuOpenId(null);
    try {
      await deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setTotal((prev) => prev - 1);
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  }

  function handleStartRename(conv: Conversation, e: React.MouseEvent) {
    e.stopPropagation();
    setMenuOpenId(null);
    setEditingId(conv.id);
    setEditTitle(conv.title || '');
  }

  async function handleSaveRename(id: string) {
    if (!editTitle.trim()) return;
    try {
      await renameConversation(id, editTitle.trim());
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: editTitle.trim() } : c))
      );
    } catch (err) {
      console.error('Failed to rename conversation:', err);
    }
    setEditingId(null);
  }

  const filteredConversations = conversations.filter((conv) =>
    (conv.title || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const groupedConversations = groupByDate(filteredConversations);

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString('uk-UA', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDate = (timestamp: string) => {
    return new Date(timestamp).toLocaleDateString('uk-UA', {
      day: 'numeric',
      month: 'short',
    });
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-4xl mx-auto space-y-6">
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
                Історія розмов
              </h1>
              <p className="text-claude-subtext font-sans text-sm">
                Усі ваші попередні розмови з асистентом
              </p>
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm text-sm font-sans">
              <Clock size={16} className="text-claude-subtext" />
              <span className="text-claude-subtext">
                {total} {total === 1 ? 'розмова' : total < 5 ? 'розмови' : 'розмов'}
              </span>
            </div>
          </div>

          {/* Search and Controls */}
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1 group">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-claude-subtext group-focus-within:text-claude-accent transition-colors" />
              </div>
              <input
                type="text"
                className="block w-full pl-11 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all shadow-sm font-sans"
                placeholder="Пошук в історії..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            {/* View Mode Toggle */}
            <div className="flex bg-white border border-claude-border rounded-xl p-1">
              <button
                onClick={() => setViewMode('comfortable')}
                className={`p-2 rounded-lg transition-colors ${
                  viewMode === 'comfortable'
                    ? 'bg-claude-accent text-white'
                    : 'text-claude-subtext hover:text-claude-text'
                }`}
                title="Зручний вигляд"
              >
                <LayoutGrid size={18} />
              </button>
              <button
                onClick={() => setViewMode('compact')}
                className={`p-2 rounded-lg transition-colors ${
                  viewMode === 'compact'
                    ? 'bg-claude-accent text-white'
                    : 'text-claude-subtext hover:text-claude-text'
                }`}
                title="Компактний вигляд"
              >
                <List size={18} />
              </button>
            </div>
          </div>
        </motion.div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-claude-accent animate-spin" />
          </div>
        )}

        {/* History Timeline */}
        {!loading && (
          <div className="space-y-8">
            {groupedConversations.map(([period, items], groupIndex) => (
              <motion.div
                key={period}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: groupIndex * 0.1 }}
              >
                {/* Period Header */}
                <div className="flex items-center gap-3 mb-4">
                  <h2 className="text-lg font-serif text-claude-text font-medium">
                    {period}
                  </h2>
                  <div className="flex-1 h-px bg-claude-border"></div>
                  <span className="text-sm text-claude-subtext font-sans">
                    {items.length}
                  </span>
                </div>

                {/* Items */}
                <div className={viewMode === 'compact' ? 'space-y-2' : 'space-y-3'}>
                  {items.map((conv, index) => (
                    <motion.div
                      key={conv.id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.3, delay: index * 0.03 }}
                      onClick={() => handleOpen(conv)}
                      className={`group bg-white rounded-xl border border-claude-border shadow-sm hover:shadow-md hover:border-claude-subtext/30 transition-all cursor-pointer ${
                        viewMode === 'compact' ? 'p-3' : 'p-4'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {/* Icon */}
                        {viewMode === 'comfortable' && (
                          <div className="w-10 h-10 rounded-lg bg-claude-sidebar border border-claude-border flex items-center justify-center flex-shrink-0">
                            <MessageSquare size={18} className="text-claude-subtext" />
                          </div>
                        )}

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              {editingId === conv.id ? (
                                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="text"
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') handleSaveRename(conv.id);
                                      if (e.key === 'Escape') setEditingId(null);
                                    }}
                                    className="flex-1 px-2 py-1 text-sm border border-claude-accent rounded focus:outline-none"
                                    autoFocus
                                  />
                                  <button
                                    onClick={() => handleSaveRename(conv.id)}
                                    className="p-1 text-green-600 hover:bg-green-50 rounded"
                                  >
                                    <Check size={16} />
                                  </button>
                                  <button
                                    onClick={() => setEditingId(null)}
                                    className="p-1 text-red-500 hover:bg-red-50 rounded"
                                  >
                                    <X size={16} />
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <h3
                                    className={`font-sans font-medium text-claude-text group-hover:text-claude-accent transition-colors line-clamp-2 ${
                                      viewMode === 'compact' ? 'text-sm' : 'text-base'
                                    }`}
                                  >
                                    {conv.title || 'Без назви'}
                                  </h3>
                                  <div
                                    className={`flex items-center gap-2 mt-1 ${
                                      viewMode === 'compact' ? 'text-xs' : 'text-sm'
                                    }`}
                                  >
                                    <span className="text-claude-subtext font-sans">
                                      {formatTime(conv.updated_at || conv.created_at)}
                                    </span>
                                    <span className="text-claude-border">&middot;</span>
                                    <span className="text-claude-subtext font-sans">
                                      {formatDate(conv.updated_at || conv.created_at)}
                                    </span>
                                  </div>
                                </>
                              )}
                            </div>

                            {/* Actions */}
                            <div className="relative">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setMenuOpenId(menuOpenId === conv.id ? null : conv.id);
                                }}
                                className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                              >
                                <MoreVertical size={16} />
                              </button>

                              {menuOpenId === conv.id && (
                                <div className="absolute right-0 top-8 z-10 w-40 bg-white rounded-lg border border-claude-border shadow-lg py-1">
                                  <button
                                    onClick={(e) => handleStartRename(conv, e)}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-claude-text hover:bg-claude-bg"
                                  >
                                    <Pencil size={14} />
                                    Перейменувати
                                  </button>
                                  <button
                                    onClick={(e) => handleDelete(conv.id, e)}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                                  >
                                    <Trash2 size={14} />
                                    Видалити
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && filteredConversations.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12"
          >
            <div className="w-16 h-16 bg-claude-bg rounded-full flex items-center justify-center mx-auto mb-4 text-claude-subtext">
              {searchQuery ? <Search size={24} /> : <MessageSquare size={24} />}
            </div>
            <h3 className="text-lg font-serif text-claude-text mb-2">
              {searchQuery ? 'Нічого не знайдено' : 'Немає розмов'}
            </h3>
            <p className="text-claude-subtext font-sans max-w-md mx-auto">
              {searchQuery
                ? 'Спробуйте змінити параметри пошуку'
                : 'Розпочніть нову розмову в чаті'}
            </p>
          </motion.div>
        )}
      </div>
    </div>
  );
}
