import React from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Mail,
  Phone,
  MapPin,
  Briefcase,
  Calendar,
  FileText,
  MessageSquare,
  Edit,
  MoreVertical,
  Building } from
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
interface ClientDetailPageProps {
  client: Client;
  onBack: () => void;
}
export function ClientDetailPage({ client, onBack }: ClientDetailPageProps) {
  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Back Button */}
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-claude-subtext hover:text-claude-text transition-colors group">

          <ArrowLeft
            size={18}
            className="group-hover:-translate-x-1 transition-transform" />

          <span className="font-sans text-sm">Назад к списку клиентов</span>
        </button>

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
          className="relative bg-white rounded-2xl p-6 md:p-8 border border-claude-border shadow-sm overflow-hidden">

          <div className="absolute top-0 left-0 w-full h-32 bg-gradient-to-r from-claude-accent/10 to-claude-bg" />

          <div className="relative flex flex-col md:flex-row items-start md:items-end gap-6 pt-12">
            <div className="w-24 h-24 md:w-32 md:h-32 rounded-full bg-claude-sidebar border-4 border-white shadow-md flex items-center justify-center text-3xl font-serif text-claude-subtext relative">
              {client.name.
              split(' ').
              map((n) => n[0]).
              slice(0, 2).
              join('')}
              <div
                className={`absolute bottom-2 right-2 w-4 h-4 rounded-full border-2 border-white ${client.status === 'active' ? 'bg-green-500' : 'bg-gray-400'}`} />

            </div>

            <div className="flex-1 mb-2">
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight">
                {client.name}
              </h1>
              <p className="text-claude-subtext mt-1 font-sans flex items-center gap-2">
                <Building size={16} />
                {client.company}
              </p>
              <div className="mt-3 inline-flex items-center px-3 py-1 rounded-lg text-sm font-medium font-sans bg-claude-accent/10 text-claude-accent border border-claude-accent/20">
                {client.type === 'corporate' ?
                'Юридическое лицо' :
                'Физическое лицо'}
              </div>
            </div>

            <div className="flex gap-2">
              <button className="p-2 bg-white border border-claude-border rounded-lg text-claude-subtext hover:text-claude-text hover:bg-claude-bg transition-colors">
                <Edit size={18} />
              </button>
              <button className="p-2 bg-white border border-claude-border rounded-lg text-claude-subtext hover:text-claude-text hover:bg-claude-bg transition-colors">
                <MoreVertical size={18} />
              </button>
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Contact Information */}
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
              delay: 0.1
            }}
            className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">

            <h2 className="text-xl font-serif text-claude-text mb-4">
              Контактная информация
            </h2>
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext">
                  <Mail size={18} />
                </div>
                <div>
                  <div className="text-xs text-claude-subtext font-sans mb-1">
                    Email
                  </div>
                  <a
                    href={`mailto:${client.email}`}
                    className="text-sm text-claude-text font-sans hover:text-claude-accent transition-colors">

                    {client.email}
                  </a>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext">
                  <Phone size={18} />
                </div>
                <div>
                  <div className="text-xs text-claude-subtext font-sans mb-1">
                    Телефон
                  </div>
                  <a
                    href={`tel:${client.phone}`}
                    className="text-sm text-claude-text font-sans hover:text-claude-accent transition-colors">

                    {client.phone}
                  </a>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext">
                  <MapPin size={18} />
                </div>
                <div>
                  <div className="text-xs text-claude-subtext font-sans mb-1">
                    Адрес
                  </div>
                  <p className="text-sm text-claude-text font-sans">
                    г. Москва, ул. Примерная, д. 10, офис 205
                  </p>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Activity Statistics */}
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
              delay: 0.2
            }}
            className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">

            <h2 className="text-xl font-serif text-claude-text mb-4">
              Статистика
            </h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                <span className="text-sm text-claude-subtext font-sans">
                  Активных дел
                </span>
                <span className="text-2xl font-serif text-claude-text">
                  {client.activeCases}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                <span className="text-sm text-claude-subtext font-sans">
                  Последний контакт
                </span>
                <span className="text-sm font-medium text-claude-text font-sans">
                  {new Date(client.lastContact).toLocaleDateString('ru-RU')}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-claude-bg rounded-lg">
                <span className="text-sm text-claude-subtext font-sans">
                  Клиент с
                </span>
                <span className="text-sm font-medium text-claude-text font-sans">
                  Январь 2023
                </span>
              </div>
            </div>
          </motion.div>

          {/* Active Cases */}
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
              delay: 0.3
            }}
            className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm md:col-span-2">

            <h2 className="text-xl font-serif text-claude-text mb-4">
              Активные дела
            </h2>
            <div className="space-y-3">
              {client.activeCases > 0 ?
              [1, 2, 3].slice(0, client.activeCases).map((i) =>
              <div
                key={i}
                className="flex items-center justify-between p-4 border border-claude-border/50 rounded-xl hover:bg-claude-bg/50 transition-colors cursor-pointer group">

                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-claude-bg group-hover:bg-white rounded-lg text-claude-accent transition-colors">
                        <Briefcase size={18} />
                      </div>
                      <div>
                        <div className="font-medium text-claude-text font-sans text-sm">
                          Дело №А40-{12345 + i}/2024
                        </div>
                        <div className="text-xs text-claude-subtext font-sans">
                          Арбитражный спор • В процессе
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-claude-subtext font-sans">
                      {new Date(2024, 0, 15 - i).toLocaleDateString('ru-RU')}
                    </div>
                  </div>
              ) :

              <div className="text-center py-8 text-claude-subtext font-sans">
                  Нет активных дел
                </div>
              }
            </div>
          </motion.div>

          {/* Recent Communications */}
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
              delay: 0.4
            }}
            className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm md:col-span-2">

            <h2 className="text-xl font-serif text-claude-text mb-4">
              Последние сообщения
            </h2>
            <div className="space-y-3">
              {[
              {
                type: 'email',
                subject: 'Обновление по делу №А40-12345/2024',
                date: '2024-01-15'
              },
              {
                type: 'call',
                subject: 'Телефонная консультация',
                date: '2024-01-12'
              },
              {
                type: 'meeting',
                subject: 'Встреча в офисе',
                date: '2024-01-08'
              }].
              map((comm, i) =>
              <div
                key={i}
                className="flex items-center gap-3 p-3 border border-claude-border/50 rounded-lg">

                  <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext">
                    <MessageSquare size={16} />
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-claude-text font-sans">
                      {comm.subject}
                    </div>
                    <div className="text-xs text-claude-subtext font-sans">
                      {comm.type === 'email' ?
                    'Email' :
                    comm.type === 'call' ?
                    'Звонок' :
                    'Встреча'}
                    </div>
                  </div>
                  <div className="text-xs text-claude-subtext font-sans">
                    {new Date(comm.date).toLocaleDateString('ru-RU')}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </div>

        {/* Action Buttons */}
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
            delay: 0.5
          }}
          className="flex flex-wrap gap-3">

          <button className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm hover:bg-[#C66345] transition-colors shadow-sm">
            <MessageSquare size={18} />
            Написать сообщение
          </button>
          <button className="flex items-center gap-2 px-4 py-2.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium text-sm hover:bg-claude-bg transition-colors">
            <Calendar size={18} />
            Назначить встречу
          </button>
          <button className="flex items-center gap-2 px-4 py-2.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium text-sm hover:bg-claude-bg transition-colors">
            <FileText size={18} />
            Создать документ
          </button>
        </motion.div>
      </div>
    </div>);

}