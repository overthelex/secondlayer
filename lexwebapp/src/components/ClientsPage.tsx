import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Users,
  ChevronRight,
  Mail,
  Phone,
  Briefcase,
  Calendar,
  Plus,
  Filter,
  MoreVertical,
  MessageSquare,
  Send,
  X } from
'lucide-react';
interface Client {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  activeCases: number;
  status: 'active' | 'inactive';
  lastContact: string;
  type: 'individual' | 'corporate';
}
const clientsData: Client[] = [
{
  id: '1',
  name: 'Александров Игорь Петрович',
  company: 'ООО "ТехноСтрой"',
  email: 'i.alexandrov@technostroy.ru',
  phone: '+7 (495) 123-45-67',
  activeCases: 3,
  status: 'active',
  lastContact: '2024-01-15',
  type: 'corporate'
},
{
  id: '2',
  name: 'Белова Мария Сергеевна',
  company: 'Частное лицо',
  email: 'maria.belova@mail.ru',
  phone: '+7 (916) 234-56-78',
  activeCases: 1,
  status: 'active',
  lastContact: '2024-01-12',
  type: 'individual'
},
{
  id: '3',
  name: 'Григорьев Андрей Владимирович',
  company: 'АО "Инвестпром"',
  email: 'a.grigoriev@investprom.ru',
  phone: '+7 (495) 345-67-89',
  activeCases: 2,
  status: 'active',
  lastContact: '2024-01-10',
  type: 'corporate'
},
{
  id: '4',
  name: 'Дмитриева Елена Николаевна',
  company: 'ИП Дмитриева Е.Н.',
  email: 'dmitrieva.en@business.ru',
  phone: '+7 (903) 456-78-90',
  activeCases: 0,
  status: 'inactive',
  lastContact: '2023-12-20',
  type: 'individual'
},
{
  id: '5',
  name: 'Ковалев Сергей Александрович',
  company: 'ООО "Логистик Плюс"',
  email: 's.kovalev@logistikplus.ru',
  phone: '+7 (495) 567-89-01',
  activeCases: 4,
  status: 'active',
  lastContact: '2024-01-14',
  type: 'corporate'
}];

interface ClientsPageProps {
  onSelectClient?: (client: Client) => void;
  onSendMessage?: (clientIds: string[]) => void;
}
export function ClientsPage({
  onSelectClient,
  onSendMessage
}: ClientsPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<
    'all' | 'individual' | 'corporate'>(
    'all');
  const [selectedClients, setSelectedClients] = useState<Set<string>>(new Set());
  const filteredClients = clientsData.filter((client) => {
    const matchesSearch =
    client.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    client.company.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filterType === 'all' || client.type === filterType;
    return matchesSearch && matchesFilter;
  });
  const stats = {
    total: clientsData.length,
    active: clientsData.filter((c) => c.status === 'active').length,
    totalCases: clientsData.reduce((sum, c) => sum + c.activeCases, 0),
    corporate: clientsData.filter((c) => c.type === 'corporate').length
  };
  const toggleClientSelection = (clientId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSelected = new Set(selectedClients);
    if (newSelected.has(clientId)) {
      newSelected.delete(clientId);
    } else {
      newSelected.add(clientId);
    }
    setSelectedClients(newSelected);
  };
  const selectAll = () => {
    if (selectedClients.size === filteredClients.length) {
      setSelectedClients(new Set());
    } else {
      setSelectedClients(new Set(filteredClients.map((c) => c.id)));
    }
  };
  const handleSendMessage = () => {
    if (onSendMessage && selectedClients.size > 0) {
      onSendMessage(Array.from(selectedClients));
    }
  };
  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header Section */}
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
          }}
          className="space-y-4">

          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight mb-2">
                Клиенты
              </h1>
              <p className="text-claude-subtext font-sans text-sm">
                Управление клиентской базой и профилями
              </p>
            </div>

            <button className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors shadow-sm active:scale-[0.98]">
              <Plus size={18} />
              Добавить клиента
            </button>
          </div>

          {/* Compact Stats */}
          <div className="flex flex-wrap gap-3 text-sm font-sans">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <span className="text-claude-subtext">Всего:</span>
              <span className="font-serif font-medium text-claude-text">
                {stats.total}
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <span className="text-green-600">Активных:</span>
              <span className="font-serif font-medium text-green-600">
                {stats.active}
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <span className="text-claude-subtext">Активных дел:</span>
              <span className="font-serif font-medium text-claude-text">
                {stats.totalCases}
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <span className="text-claude-subtext">Корпоративных:</span>
              <span className="font-serif font-medium text-claude-text">
                {stats.corporate}
              </span>
            </div>
          </div>

          {/* Search and Filter Bar */}
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1 group">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-claude-subtext group-focus-within:text-claude-accent transition-colors" />
              </div>
              <input
                type="text"
                className="block w-full pl-11 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all shadow-sm font-sans"
                placeholder="Поиск по имени или компании..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)} />

            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setFilterType('all')}
                className={`px-4 py-3 rounded-xl font-medium text-sm font-sans transition-all ${filterType === 'all' ? 'bg-claude-accent text-white shadow-sm' : 'bg-white text-claude-text border border-claude-border hover:bg-claude-bg'}`}>

                Все
              </button>
              <button
                onClick={() => setFilterType('individual')}
                className={`px-4 py-3 rounded-xl font-medium text-sm font-sans transition-all ${filterType === 'individual' ? 'bg-claude-accent text-white shadow-sm' : 'bg-white text-claude-text border border-claude-border hover:bg-claude-bg'}`}>

                Физ. лица
              </button>
              <button
                onClick={() => setFilterType('corporate')}
                className={`px-4 py-3 rounded-xl font-medium text-sm font-sans transition-all ${filterType === 'corporate' ? 'bg-claude-accent text-white shadow-sm' : 'bg-white text-claude-text border border-claude-border hover:bg-claude-bg'}`}>

                Юр. лица
              </button>
            </div>
          </div>

          {/* Select All */}
          {filteredClients.length > 0 &&
          <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 px-3 py-2 bg-white rounded-lg border border-claude-border hover:bg-claude-bg transition-colors cursor-pointer">
                <input
                type="checkbox"
                checked={
                selectedClients.size === filteredClients.length &&
                filteredClients.length > 0
                }
                onChange={selectAll}
                className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent cursor-pointer" />

                <span className="text-sm font-medium text-claude-text font-sans">
                  Выбрать все
                </span>
              </label>
              {selectedClients.size > 0 &&
            <span className="text-sm text-claude-subtext font-sans">
                  Выбрано: {selectedClients.size}
                </span>
            }
            </div>
          }
        </motion.div>

        {/* Clients List */}
        <div className="space-y-3">
          {filteredClients.map((client, index) =>
          <motion.div
            key={client.id}
            initial={{
              opacity: 0,
              y: 20
            }}
            animate={{
              opacity: 1,
              y: 0
            }}
            transition={{
              duration: 0.4,
              delay: index * 0.03 + 0.2
            }}
            onClick={() => onSelectClient?.(client)}
            className="group bg-white rounded-2xl p-5 border border-claude-border shadow-sm hover:shadow-md hover:border-claude-subtext/30 transition-all cursor-pointer relative">

              <div className="flex items-start gap-4">
                {/* Checkbox */}
                <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                  <input
                  type="checkbox"
                  checked={selectedClients.has(client.id)}
                  onChange={(e) => toggleClientSelection(client.id, e)}
                  className="w-4 h-4 rounded border-claude-border text-claude-accent focus:ring-claude-accent cursor-pointer" />

                </div>

                {/* Avatar */}
                <div className="w-12 h-12 rounded-full bg-claude-sidebar border-2 border-white shadow-sm flex items-center justify-center text-lg font-serif text-claude-subtext flex-shrink-0 relative">
                  {client.name.
                split(' ').
                map((n) => n[0]).
                slice(0, 2).
                join('')}
                  <div
                  className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white ${client.status === 'active' ? 'bg-green-500' : 'bg-gray-400'}`} />

                </div>

                {/* Main Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <div>
                      <h3 className="text-lg font-serif font-medium text-claude-text group-hover:text-claude-accent transition-colors">
                        {client.name}
                      </h3>
                      <p className="text-sm text-claude-subtext font-sans">
                        {client.company}
                      </p>
                    </div>

                    <button
                    onClick={(e) => e.stopPropagation()}
                    className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors opacity-0 group-hover:opacity-100">

                      <MoreVertical size={18} />
                    </button>
                  </div>

                  {/* Contact Info & Stats */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
                    <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
                      <Mail size={14} className="flex-shrink-0" />
                      <span className="truncate">{client.email}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
                      <Phone size={14} className="flex-shrink-0" />
                      <span>{client.phone}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
                      <Briefcase size={14} className="flex-shrink-0" />
                      <span>
                        {client.activeCases}{' '}
                        {client.activeCases === 1 ? 'дело' : 'дел'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
                      <Calendar size={14} className="flex-shrink-0" />
                      <span>
                        {new Date(client.lastContact).toLocaleDateString(
                        'ru-RU'
                      )}
                      </span>
                    </div>
                  </div>

                  {/* Quick Actions */}
                  <div className="flex items-center gap-2 mt-4 pt-4 border-t border-claude-border/50">
                    <button
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-sans text-claude-text hover:bg-claude-bg rounded-lg transition-colors">

                      <MessageSquare size={14} />
                      Написать
                    </button>
                    <button
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-sans text-claude-text hover:bg-claude-bg rounded-lg transition-colors">

                      <Briefcase size={14} />
                      Дела
                    </button>
                    <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-sans text-claude-accent hover:bg-claude-accent/10 rounded-lg transition-colors ml-auto">
                      Открыть профиль
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </div>

        {filteredClients.length === 0 &&
        <motion.div
          initial={{
            opacity: 0
          }}
          animate={{
            opacity: 1
          }}
          className="text-center py-12">

            <div className="w-16 h-16 bg-claude-bg rounded-full flex items-center justify-center mx-auto mb-4 text-claude-subtext">
              <Search size={24} />
            </div>
            <h3 className="text-lg font-serif text-claude-text mb-2">
              Клиенты не найдены
            </h3>
            <p className="text-claude-subtext font-sans max-w-md mx-auto">
              Попробуйте изменить параметры поиска или добавьте нового клиента
            </p>
          </motion.div>
        }
      </div>

      {/* Floating Action Bar */}
      <AnimatePresence>
        {selectedClients.size > 0 &&
        <motion.div
          initial={{
            y: 100,
            opacity: 0
          }}
          animate={{
            y: 0,
            opacity: 1
          }}
          exit={{
            y: 100,
            opacity: 0
          }}
          transition={{
            duration: 0.3,
            ease: [0.22, 1, 0.36, 1]
          }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">

            <div className="bg-claude-text text-white rounded-2xl shadow-2xl p-4 flex items-center gap-4">
              <div className="flex items-center gap-3 px-2">
                <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-serif font-medium">
                  {selectedClients.size}
                </div>
                <span className="font-sans text-sm">
                  {selectedClients.size === 1 ?
                'клиент выбран' :
                'клиентов выбрано'}
                </span>
              </div>

              <div className="h-8 w-px bg-white/20" />

              <div className="flex gap-2">
                <button
                onClick={handleSendMessage}
                className="flex items-center gap-2 px-4 py-2 bg-white text-claude-text rounded-xl font-medium text-sm font-sans hover:bg-gray-100 transition-colors">

                  <Send size={16} />
                  Отправить сообщение
                </button>
                <button
                onClick={() => setSelectedClients(new Set())}
                className="p-2 hover:bg-white/10 rounded-xl transition-colors">

                  <X size={20} />
                </button>
              </div>
            </div>
          </motion.div>
        }
      </AnimatePresence>
    </div>);

}