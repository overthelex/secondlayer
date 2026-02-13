/**
 * Settings Tab
 * Manage spending limits, email notifications, and account preferences
 */

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  DollarSign,
  Mail,
  Bell,
  Save,
  User,
  Calendar,
  TrendingUp,
  Send,
  CheckCircle,
  AlertCircle,
} from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';
import { useAuth } from '../../contexts/AuthContext';

export function SettingsTab() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);

  // Settings state
  const [dailyLimit, setDailyLimit] = useState<string>('10.00');
  const [monthlyLimit, setMonthlyLimit] = useState<string>('100.00');
  const [emailNotifications, setEmailNotifications] = useState({
    lowBalance: true,
    paymentConfirmations: true,
    monthlyReports: false,
  });

  // Load current settings
  useEffect(() => {
    const fetchSettings = async () => {
      setIsLoading(true);
      try {
        const [balanceRes, prefsRes] = await Promise.all([
          api.billing.getBalance(),
          api.billing.getEmailPreferences(),
        ]);

        const balanceData = balanceRes.data;
        setDailyLimit((Number(balanceData.daily_limit_usd) || 10).toFixed(2));
        setMonthlyLimit((Number(balanceData.monthly_limit_usd) || 100).toFixed(2));

        const prefs = prefsRes.data;
        setEmailNotifications({
          lowBalance: prefs.notify_low_balance ?? true,
          paymentConfirmations: prefs.notify_payment_success ?? true,
          monthlyReports: prefs.notify_monthly_report ?? false,
        });
      } catch (error) {
        console.error('Failed to load settings:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSettings();
  }, []);

  const handleSaveSettings = async () => {
    setIsSaving(true);

    try {
      await api.billing.updateSettings({
        daily_limit_usd: parseFloat(dailyLimit),
        monthly_limit_usd: parseFloat(monthlyLimit),
        notify_low_balance: emailNotifications.lowBalance,
        notify_payment_success: emailNotifications.paymentConfirmations,
        notify_monthly_report: emailNotifications.monthlyReports,
      });

      showToast.success('Налаштування збережено');
    } catch (error: any) {
      console.error('Failed to save settings:', error);
      const message = error.response?.data?.message || 'Не вдалося зберегти налаштування';
      showToast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSendTestEmail = async () => {
    setIsSendingEmail(true);

    try {
      await api.billing.testEmail();
      showToast.success('Тестовий лист надіслано! Перевірте вхідні.');
    } catch (error: any) {
      console.error('Failed to send test email:', error);
      const message = error.response?.data?.message || 'Не вдалося надіслати тестовий лист';
      showToast.error(message);
    } finally {
      setIsSendingEmail(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Account Information */}
      <div className="bg-white border border-claude-border rounded-xl p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4 flex items-center gap-2">
          <User size={20} />
          Інформація про акаунт
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-claude-subtext mb-1">Електронна пошта</label>
            <div className="flex items-center gap-2 text-sm text-claude-text">
              <Mail size={16} className="text-claude-subtext" />
              {user?.email || 'Недоступно'}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-subtext mb-1">Імʼя</label>
            <div className="flex items-center gap-2 text-sm text-claude-text">
              <User size={16} className="text-claude-subtext" />
              {user?.name || 'Недоступно'}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-subtext mb-1">
              Акаунт створено
            </label>
            <div className="flex items-center gap-2 text-sm text-claude-text">
              <Calendar size={16} className="text-claude-subtext" />
              {user?.createdAt ? format(new Date(user.createdAt), 'MMM dd, yyyy') : 'N/A'}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-subtext mb-1">
              Останній вхід
            </label>
            <div className="flex items-center gap-2 text-sm text-claude-text">
              <Calendar size={16} className="text-claude-subtext" />
              {user?.lastLogin ? format(new Date(user.lastLogin), 'MMM dd, yyyy HH:mm') : 'N/A'}
            </div>
          </div>
        </div>
      </div>

      {/* Spending Limits */}
      <div className="bg-white border border-claude-border rounded-xl p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4 flex items-center gap-2">
          <DollarSign size={20} />
          Ліміти витрат
        </h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">
              Денний ліміт (USD)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-claude-subtext">
                $
              </span>
              <input
                type="number"
                min="1"
                step="0.01"
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
                className="w-full pl-8 pr-4 py-2.5 border border-claude-border rounded-lg focus:outline-none focus:ring-2 focus:ring-claude-accent/20"
              />
            </div>
            <p className="text-xs text-claude-subtext mt-1">
              Максимальна сума витрат на день
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">
              Місячний ліміт (USD)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-claude-subtext">
                $
              </span>
              <input
                type="number"
                min="1"
                step="0.01"
                value={monthlyLimit}
                onChange={(e) => setMonthlyLimit(e.target.value)}
                className="w-full pl-8 pr-4 py-2.5 border border-claude-border rounded-lg focus:outline-none focus:ring-2 focus:ring-claude-accent/20"
              />
            </div>
            <p className="text-xs text-claude-subtext mt-1">
              Максимальна сума витрат на місяць
            </p>
          </div>

          <button
            onClick={handleSaveSettings}
            disabled={isSaving}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium">
            {isSaving ? (
              <>
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}>
                  <Save size={18} />
                </motion.div>
                Збереження...
              </>
            ) : (
              <>
                <Save size={18} />
                Зберегти налаштування
              </>
            )}
          </button>
        </div>
      </div>

      {/* Email Notifications */}
      <div className="bg-white border border-claude-border rounded-xl p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4 flex items-center gap-2">
          <Bell size={20} />
          Email-сповіщення
        </h3>

        <div className="space-y-4">
          <label className="flex items-center justify-between p-4 border border-claude-border rounded-lg hover:bg-claude-bg transition-colors cursor-pointer">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle size={18} className="text-claude-accent" />
                <span className="font-medium text-claude-text">Сповіщення про низький баланс</span>
              </div>
              <p className="text-sm text-claude-subtext">
                Отримуйте сповіщення, коли баланс падає нижче $5
              </p>
            </div>
            <input
              type="checkbox"
              checked={emailNotifications.lowBalance}
              onChange={(e) =>
                setEmailNotifications({ ...emailNotifications, lowBalance: e.target.checked })
              }
              className="w-5 h-5 text-claude-accent border-claude-border rounded focus:ring-claude-accent"
            />
          </label>

          <label className="flex items-center justify-between p-4 border border-claude-border rounded-lg hover:bg-claude-bg transition-colors cursor-pointer">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle size={18} className="text-claude-accent" />
                <span className="font-medium text-claude-text">Підтвердження оплат</span>
              </div>
              <p className="text-sm text-claude-subtext">
                Отримуйте email-підтвердження успішних оплат
              </p>
            </div>
            <input
              type="checkbox"
              checked={emailNotifications.paymentConfirmations}
              onChange={(e) =>
                setEmailNotifications({
                  ...emailNotifications,
                  paymentConfirmations: e.target.checked,
                })
              }
              className="w-5 h-5 text-claude-accent border-claude-border rounded focus:ring-claude-accent"
            />
          </label>

          <label className="flex items-center justify-between p-4 border border-claude-border rounded-lg hover:bg-claude-bg transition-colors cursor-pointer">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp size={18} className="text-claude-accent" />
                <span className="font-medium text-claude-text">Щомісячні звіти про використання</span>
              </div>
              <p className="text-sm text-claude-subtext">
                Отримуйте щомісячні зведення витрат та використання
              </p>
            </div>
            <input
              type="checkbox"
              checked={emailNotifications.monthlyReports}
              onChange={(e) =>
                setEmailNotifications({ ...emailNotifications, monthlyReports: e.target.checked })
              }
              className="w-5 h-5 text-claude-accent border-claude-border rounded focus:ring-claude-accent"
            />
          </label>
        </div>
      </div>

      {/* Test Email */}
      <div className="bg-white border border-claude-border rounded-xl p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4 flex items-center gap-2">
          <Send size={20} />
          Тестові email-сповіщення
        </h3>

        <p className="text-sm text-claude-subtext mb-4">
          Надіслати тестовий лист на <strong>{user?.email}</strong>, щоб перевірити, що ваші email-сповіщення
          працюють коректно.
        </p>

        <button
          onClick={handleSendTestEmail}
          disabled={isSendingEmail}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-white border-2 border-claude-accent text-claude-accent rounded-lg hover:bg-claude-accent hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed font-medium">
          {isSendingEmail ? (
            <>
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}>
                <Send size={18} />
              </motion.div>
              Надсилання...
            </>
          ) : (
            <>
              <Send size={18} />
              Надіслати тестовий лист
            </>
          )}
        </button>

        <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-xs text-blue-800">
            <strong>Примітка:</strong> Тестовий лист має надійти протягом 1-2 хвилин. Перевірте папку спам, якщо не бачите його у вхідних.
          </p>
        </div>
      </div>

      {/* Email Configuration Info */}
      <div className="bg-claude-bg border border-claude-border rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Mail size={20} className="text-claude-accent flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-claude-text font-medium mb-1">Налаштування поштового сервісу</p>
            <p className="text-xs text-claude-subtext">
              Листи надсилаються з <strong>billing@legal.org.ua</strong> через SMTP-сервер mail.legal.org.ua. Якщо у вас є проблеми з отриманням листів, зверніться до підтримки.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
