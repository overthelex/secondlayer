/**
 * Toast Notification Utility
 * Wrapper around react-hot-toast with custom styling
 */

import toast from 'react-hot-toast';

export const showToast = {
  success: (message: string, duration = 3000) => {
    return toast.success(message, {
      duration,
      style: {
        background: '#52c41a',
        color: '#fff',
        padding: '16px',
        borderRadius: '8px',
      },
      iconTheme: {
        primary: '#fff',
        secondary: '#52c41a',
      },
    });
  },

  error: (message: string, duration = 4000) => {
    return toast.error(message, {
      duration,
      style: {
        background: '#ff4d4f',
        color: '#fff',
        padding: '16px',
        borderRadius: '8px',
      },
      iconTheme: {
        primary: '#fff',
        secondary: '#ff4d4f',
      },
    });
  },

  info: (message: string, duration = 3000) => {
    return toast(message, {
      duration,
      icon: 'ℹ️',
      style: {
        background: '#1890ff',
        color: '#fff',
        padding: '16px',
        borderRadius: '8px',
      },
    });
  },

  warning: (message: string, duration = 3500) => {
    return toast(message, {
      duration,
      icon: '⚠️',
      style: {
        background: '#fa8c16',
        color: '#fff',
        padding: '16px',
        borderRadius: '8px',
      },
    });
  },

  loading: (message: string) => {
    return toast.loading(message, {
      style: {
        background: '#2D2D2D',
        color: '#fff',
        padding: '16px',
        borderRadius: '8px',
      },
    });
  },

  promise: <T,>(
    promise: Promise<T>,
    messages: {
      loading: string;
      success: string;
      error: string;
    }
  ) => {
    return toast.promise(promise, messages, {
      style: {
        padding: '16px',
        borderRadius: '8px',
      },
      success: {
        style: {
          background: '#52c41a',
          color: '#fff',
        },
        iconTheme: {
          primary: '#fff',
          secondary: '#52c41a',
        },
      },
      error: {
        style: {
          background: '#ff4d4f',
          color: '#fff',
        },
        iconTheme: {
          primary: '#fff',
          secondary: '#ff4d4f',
        },
      },
    });
  },

  dismiss: (toastId?: string) => {
    toast.dismiss(toastId);
  },
};

export default showToast;
