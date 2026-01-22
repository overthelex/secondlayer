import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Mail,
  Lock,
  Key,
  Smartphone,
  QrCode,
  Chrome,
  Shield,
  ArrowRight } from
'lucide-react';
type AuthMethod = 'password' | 'hardware-key' | 'phone-key';
export function LoginPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [authMethod, setAuthMethod] = useState<AuthMethod>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showQR, setShowQR] = useState(false);
  const handleGoogleAuth = () => {
    console.log('Google authentication');
  };
  const handlePasswordAuth = () => {
    console.log('Password authentication', {
      email,
      password
    });
  };
  const handleHardwareKey = () => {
    console.log('Hardware key authentication');
  };
  const handlePhoneKey = () => {
    setShowQR(true);
    console.log('Phone key authentication');
  };
  return (
    <div className="min-h-screen bg-gradient-to-br from-claude-bg via-white to-claude-sidebar flex items-center justify-center p-4">
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
          duration: 0.6,
          ease: [0.22, 1, 0.36, 1]
        }}
        className="w-full max-w-md">

        {/* Logo */}
        <div className="text-center mb-8">
          <motion.div
            initial={{
              scale: 0.9,
              opacity: 0
            }}
            animate={{
              scale: 1,
              opacity: 1
            }}
            transition={{
              duration: 0.5,
              delay: 0.1
            }}
            className="inline-block">

            <img
              src="/Image.jpg"
              alt="Lex"
              className="h-20 w-auto mx-auto" />

          </motion.div>
        </div>

        {/* Main Card */}
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
            duration: 0.6,
            delay: 0.2
          }}
          className="bg-white rounded-2xl shadow-xl border border-claude-border p-8">

          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-sans text-claude-text font-medium mb-2">
              {isLogin ? 'Вход в систему' : 'Регистрация'}
            </h1>
            <p className="text-claude-subtext font-sans text-sm">
              {isLogin ?
              'Выберите удобный способ входа' :
              'Создайте аккаунт для начала работы'}
            </p>
          </div>

          {/* Google Auth Button */}
          <motion.button
            whileHover={{
              scale: 1.02
            }}
            whileTap={{
              scale: 0.98
            }}
            onClick={handleGoogleAuth}
            className="w-full flex items-center justify-center gap-3 px-4 py-3.5 bg-white border-2 border-claude-border hover:border-claude-accent hover:bg-claude-bg rounded-xl font-medium text-claude-text transition-all shadow-sm mb-6 font-sans">

            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg">

              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4" />

              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853" />

              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05" />

              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335" />

            </svg>
            {isLogin ? 'Войти через Google' : 'Зарегистрироваться через Google'}
          </motion.button>

          {/* Divider */}
          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-claude-border"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-white text-claude-subtext font-sans">
                или
              </span>
            </div>
          </div>

          {/* Auth Method Tabs */}
          <div className="flex gap-2 mb-6 bg-claude-bg p-1 rounded-xl">
            <button
              onClick={() => setAuthMethod('password')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg font-medium text-sm font-sans transition-all ${authMethod === 'password' ? 'bg-white text-claude-text shadow-sm' : 'text-claude-subtext hover:text-claude-text'}`}>

              <Lock size={16} />
              Пароль
            </button>
            <button
              onClick={() => setAuthMethod('hardware-key')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg font-medium text-sm font-sans transition-all ${authMethod === 'hardware-key' ? 'bg-white text-claude-text shadow-sm' : 'text-claude-subtext hover:text-claude-text'}`}>

              <Key size={16} />
              Ключ
            </button>
            <button
              onClick={() => setAuthMethod('phone-key')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg font-medium text-sm font-sans transition-all ${authMethod === 'phone-key' ? 'bg-white text-claude-text shadow-sm' : 'text-claude-subtext hover:text-claude-text'}`}>

              <Smartphone size={16} />
              Телефон
            </button>
          </div>

          {/* Auth Forms */}
          <AnimatePresence mode="wait">
            {authMethod === 'password' &&
            <motion.div
              key="password"
              initial={{
                opacity: 0,
                x: -20
              }}
              animate={{
                opacity: 1,
                x: 0
              }}
              exit={{
                opacity: 0,
                x: 20
              }}
              transition={{
                duration: 0.3
              }}
              className="space-y-4">

                <div>
                  <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                    Email
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Mail size={18} className="text-claude-subtext" />
                    </div>
                    <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="block w-full pl-10 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-claude-text font-sans mb-2">
                    Пароль
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Lock size={18} className="text-claude-subtext" />
                    </div>
                    <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="block w-full pl-10 pr-4 py-3 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans" />

                  </div>
                </div>

                {isLogin &&
              <div className="flex justify-end">
                    <button className="text-sm text-claude-accent hover:text-[#C66345] font-sans">
                      Забыли пароль?
                    </button>
                  </div>
              }

                <motion.button
                whileHover={{
                  scale: 1.02
                }}
                whileTap={{
                  scale: 0.98
                }}
                onClick={handlePasswordAuth}
                className="w-full flex items-center justify-center gap-2 px-4 py-3.5 bg-black text-white rounded-xl font-medium hover:bg-gray-800 transition-colors shadow-sm font-sans">

                  {isLogin ? 'Войти' : 'Зарегистрироваться'}
                  <ArrowRight size={18} />
                </motion.button>
              </motion.div>
            }

            {authMethod === 'hardware-key' &&
            <motion.div
              key="hardware-key"
              initial={{
                opacity: 0,
                x: -20
              }}
              animate={{
                opacity: 1,
                x: 0
              }}
              exit={{
                opacity: 0,
                x: 20
              }}
              transition={{
                duration: 0.3
              }}
              className="space-y-6">

                <div className="text-center py-8">
                  <motion.div
                  animate={{
                    scale: [1, 1.1, 1]
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity
                  }}
                  className="inline-flex items-center justify-center w-20 h-20 bg-claude-accent/10 rounded-full mb-4">

                    <Shield size={40} className="text-claude-accent" />
                  </motion.div>
                  <h3 className="text-lg font-serif text-claude-text mb-2">
                    Подключите ключ безопасности
                  </h3>
                  <p className="text-sm text-claude-subtext font-sans mb-6">
                    Вставьте USB-ключ или используйте NFC
                  </p>
                  <motion.button
                  whileHover={{
                    scale: 1.02
                  }}
                  whileTap={{
                    scale: 0.98
                  }}
                  onClick={handleHardwareKey}
                  className="px-6 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans">

                    Активировать ключ
                  </motion.button>
                </div>
              </motion.div>
            }

            {authMethod === 'phone-key' &&
            <motion.div
              key="phone-key"
              initial={{
                opacity: 0,
                x: -20
              }}
              animate={{
                opacity: 1,
                x: 0
              }}
              exit={{
                opacity: 0,
                x: 20
              }}
              transition={{
                duration: 0.3
              }}
              className="space-y-6">

                {!showQR ?
              <div className="text-center py-8">
                    <motion.div
                  animate={{
                    rotate: [0, 5, -5, 0]
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity
                  }}
                  className="inline-flex items-center justify-center w-20 h-20 bg-claude-accent/10 rounded-full mb-4">

                      <Smartphone size={40} className="text-claude-accent" />
                    </motion.div>
                    <h3 className="text-lg font-serif text-claude-text mb-2">
                      Вход через телефон
                    </h3>
                    <p className="text-sm text-claude-subtext font-sans mb-6">
                      Отсканируйте QR-код в мобильном приложении
                    </p>
                    <motion.button
                  whileHover={{
                    scale: 1.02
                  }}
                  whileTap={{
                    scale: 0.98
                  }}
                  onClick={handlePhoneKey}
                  className="px-6 py-3 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors shadow-sm font-sans">

                      Показать QR-код
                    </motion.button>
                  </div> :

              <motion.div
                initial={{
                  scale: 0.9,
                  opacity: 0
                }}
                animate={{
                  scale: 1,
                  opacity: 1
                }}
                className="text-center py-6">

                    <div className="inline-flex items-center justify-center w-48 h-48 bg-white border-2 border-claude-border rounded-2xl mb-4 relative overflow-hidden">
                      <QrCode size={120} className="text-claude-text" />
                      <div className="absolute inset-0 bg-gradient-to-br from-claude-accent/5 to-transparent"></div>
                    </div>
                    <h3 className="text-lg font-serif text-claude-text mb-2">
                      Отсканируйте код
                    </h3>
                    <p className="text-sm text-claude-subtext font-sans mb-4">
                      Откройте приложение на телефоне и наведите камеру
                    </p>
                    <button
                  onClick={() => setShowQR(false)}
                  className="text-sm text-claude-accent hover:text-[#C66345] font-sans">

                      Отменить
                    </button>
                  </motion.div>
              }
              </motion.div>
            }
          </AnimatePresence>
        </motion.div>

        {/* Toggle Login/Register */}
        <motion.div
          initial={{
            opacity: 0
          }}
          animate={{
            opacity: 1
          }}
          transition={{
            delay: 0.4
          }}
          className="text-center mt-6">

          <p className="text-claude-subtext font-sans text-sm">
            {isLogin ? 'Нет аккаунта?' : 'Уже есть аккаунт?'}{' '}
            <button
              onClick={() => setIsLogin(!isLogin)}
              className="text-claude-accent hover:text-[#C66345] font-medium">

              {isLogin ? 'Зарегистрироваться' : 'Войти'}
            </button>
          </p>
        </motion.div>

        {/* Footer */}
        <motion.div
          initial={{
            opacity: 0
          }}
          animate={{
            opacity: 1
          }}
          transition={{
            delay: 0.5
          }}
          className="text-center mt-8 text-xs text-claude-subtext font-sans">

          <p>
            Продолжая, вы соглашаетесь с{' '}
            <a href="#" className="text-claude-accent hover:text-[#C66345]">
              Условиями использования
            </a>{' '}
            и{' '}
            <a href="#" className="text-claude-accent hover:text-[#C66345]">
              Политикой конфиденциальности
            </a>
          </p>
        </motion.div>
      </motion.div>
    </div>);

}