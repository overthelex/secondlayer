import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import showToast from '../utils/toast';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const BASE_URL = API_URL.replace(/\/api$/, '');

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const verifyEmail = async () => {
      const token = searchParams.get('token');

      if (!token) {
        setStatus('error');
        setMessage('Invalid verification link');
        return;
      }

      try {
        const response = await fetch(`${BASE_URL}/auth/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || 'Verification failed');
        }

        setStatus('success');
        setMessage('Email verified successfully! You can now login.');
        showToast.success('Email verified!');

        setTimeout(() => {
          navigate('/login');
        }, 3000);
      } catch (err: any) {
        setStatus('error');
        setMessage(err.message || 'Verification failed');
        showToast.error('Verification failed');
      }
    };

    verifyEmail();
  }, [searchParams, navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-claude-bg via-white to-claude-sidebar flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-2xl shadow-xl border border-claude-border p-8 max-w-md w-full text-center"
      >
        {status === 'loading' && (
          <>
            <Loader2 size={64} className="text-claude-accent animate-spin mx-auto mb-4" />
            <h1 className="text-2xl font-sans text-claude-text mb-2">Verifying Email...</h1>
            <p className="text-claude-subtext">Please wait while we verify your email address.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle size={64} className="text-green-500 mx-auto mb-4" />
            <h1 className="text-2xl font-sans text-claude-text mb-2">Email Verified!</h1>
            <p className="text-claude-subtext mb-6">{message}</p>
            <p className="text-sm text-claude-subtext">Redirecting to login...</p>
          </>
        )}

        {status === 'error' && (
          <>
            <XCircle size={64} className="text-red-500 mx-auto mb-4" />
            <h1 className="text-2xl font-sans text-claude-text mb-2">Verification Failed</h1>
            <p className="text-claude-subtext mb-6">{message}</p>
            <button
              onClick={() => navigate('/login')}
              className="px-6 py-3 bg-black text-white rounded-xl hover:bg-gray-800 transition-colors font-sans"
            >
              Go to Login
            </button>
          </>
        )}
      </motion.div>
    </div>
  );
}
