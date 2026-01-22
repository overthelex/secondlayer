import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Mail,
  MessageSquare,
  Send,
  Users,
  FileText,
  Image,
  Paperclip } from
'lucide-react';
interface ClientMessagingPageProps {
  clientIds: string[];
  onBack: () => void;
}
export function ClientMessagingPage({
  clientIds,
  onBack
}: ClientMessagingPageProps) {
  const [messageType, setMessageType] = useState<'email' | 'sms'>('email');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const handleSend = () => {
    // Handle sending logic here
    console.log('Sending message to:', clientIds);
    console.log('Type:', messageType);
    console.log('Subject:', subject);
    console.log('Message:', message);
  };
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
            duration: 0.5
          }}
          className="bg-white rounded-2xl p-6 md:p-8 border border-claude-border shadow-sm">

          <div className="flex items-center gap-4 mb-4">
            <div className="p-3 bg-claude-accent/10 rounded-xl text-claude-accent">
              <Send size={24} />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-serif text-claude-text font-medium">
                Отправить сообщение
              </h1>
              <p className="text-claude-subtext font-sans mt-1">
                Рассылка для {clientIds.length}{' '}
                {clientIds.length === 1 ? 'клиента' : 'клиентов'}
              </p>
            </div>
          </div>

          {/* Recipients Info */}
          <div className="flex items-center gap-2 p-3 bg-claude-bg rounded-xl">
            <Users size={16} className="text-claude-subtext" />
            <span className="text-sm text-claude-subtext font-sans">
              Получатели: {clientIds.length}{' '}
              {clientIds.length === 1 ? 'клиент' : 'клиентов'}
            </span>
          </div>
        </motion.div>

        {/* Message Type Selection */}
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

          <h2 className="text-lg font-serif text-claude-text mb-4">
            Тип сообщения
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMessageType('email')}
              className={`flex items-center gap-3 p-4 rounded-xl border-2 transition-all ${messageType === 'email' ? 'border-claude-accent bg-claude-accent/5' : 'border-claude-border hover:border-claude-subtext/30'}`}>

              <div
                className={`p-2 rounded-lg ${messageType === 'email' ? 'bg-claude-accent text-white' : 'bg-claude-bg text-claude-subtext'}`}>

                <Mail size={20} />
              </div>
              <div className="text-left">
                <div className="font-medium text-claude-text font-sans text-sm">
                  Email
                </div>
                <div className="text-xs text-claude-subtext font-sans">
                  Электронная почта
                </div>
              </div>
            </button>

            <button
              onClick={() => setMessageType('sms')}
              className={`flex items-center gap-3 p-4 rounded-xl border-2 transition-all ${messageType === 'sms' ? 'border-claude-accent bg-claude-accent/5' : 'border-claude-border hover:border-claude-subtext/30'}`}>

              <div
                className={`p-2 rounded-lg ${messageType === 'sms' ? 'bg-claude-accent text-white' : 'bg-claude-bg text-claude-subtext'}`}>

                <MessageSquare size={20} />
              </div>
              <div className="text-left">
                <div className="font-medium text-claude-text font-sans text-sm">
                  SMS
                </div>
                <div className="text-xs text-claude-subtext font-sans">
                  Текстовое сообщение
                </div>
              </div>
            </button>
          </div>
        </motion.div>

        {/* Message Form */}
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
          className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm space-y-6">

          <h2 className="text-lg font-serif text-claude-text">
            Содержание сообщения
          </h2>

          {/* Subject (Email only) */}
          {messageType === 'email' &&
          <div>
              <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                Тема письма
              </label>
              <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Введите тему письма..."
              className="w-full px-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

            </div>
          }

          {/* Message Body */}
          <div>
            <label className="block text-sm font-medium text-claude-text font-sans mb-2">
              {messageType === 'email' ? 'Текст письма' : 'Текст сообщения'}
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
              messageType === 'email' ?
              'Введите текст письма...' :
              'Введите текст SMS (макс. 160 символов)...'
              }
              rows={messageType === 'email' ? 10 : 4}
              maxLength={messageType === 'sms' ? 160 : undefined}
              className="w-full px-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all resize-none font-sans" />

            {messageType === 'sms' &&
            <div className="text-xs text-claude-subtext font-sans mt-2">
                {message.length}/160 символов
              </div>
            }
          </div>

          {/* Attachments (Email only) */}
          {messageType === 'email' &&
          <div>
              <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                Вложения
              </label>
              <div className="border-2 border-dashed border-claude-border rounded-xl p-6 text-center hover:border-claude-accent/50 transition-colors cursor-pointer">
                <div className="flex flex-col items-center gap-2">
                  <div className="p-3 bg-claude-bg rounded-xl text-claude-subtext">
                    <Paperclip size={24} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-claude-text font-sans">
                      Нажмите для добавления файлов
                    </p>
                    <p className="text-xs text-claude-subtext font-sans mt-1">
                      или перетащите файлы сюда
                    </p>
                  </div>
                </div>
              </div>
            </div>
          }

          {/* Templates */}
          <div>
            <label className="block text-sm font-medium text-claude-text font-sans mb-2">
              Шаблоны
            </label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <button className="p-3 text-left border border-claude-border rounded-lg hover:border-claude-accent hover:bg-claude-accent/5 transition-all">
                <div className="text-sm font-medium text-claude-text font-sans">
                  Напоминание о встрече
                </div>
                <div className="text-xs text-claude-subtext font-sans mt-1">
                  Стандартный шаблон
                </div>
              </button>
              <button className="p-3 text-left border border-claude-border rounded-lg hover:border-claude-accent hover:bg-claude-accent/5 transition-all">
                <div className="text-sm font-medium text-claude-text font-sans">
                  Обновление по делу
                </div>
                <div className="text-xs text-claude-subtext font-sans mt-1">
                  Информационный
                </div>
              </button>
              <button className="p-3 text-left border border-claude-border rounded-lg hover:border-claude-accent hover:bg-claude-accent/5 transition-all">
                <div className="text-sm font-medium text-claude-text font-sans">
                  Запрос документов
                </div>
                <div className="text-xs text-claude-subtext font-sans mt-1">
                  Официальный
                </div>
              </button>
            </div>
          </div>
        </motion.div>

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
            delay: 0.3
          }}
          className="flex flex-col sm:flex-row gap-3">

          <button
            onClick={handleSend}
            disabled={
            !message.trim() || messageType === 'email' && !subject.trim()
            }
            className="flex-1 flex items-center justify-center gap-2 px-6 py-3.5 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">

            <Send size={18} />
            Отправить {messageType === 'email' ? 'письмо' : 'SMS'}
          </button>
          <button className="px-6 py-3.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium hover:bg-claude-bg transition-colors">
            Сохранить черновик
          </button>
          <button
            onClick={onBack}
            className="px-6 py-3.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium hover:bg-claude-bg transition-colors">

            Отмена
          </button>
        </motion.div>
      </div>
    </div>);

}