import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { validateEnv } from './config/env'

// Suppress known third-party library deprecation warnings
const originalWarn = console.warn;
const originalError = console.error;

console.warn = (...args: any[]) => {
  const msg = args[0]?.toString() || '';
  // Suppress Ant Design deprecation warnings from Refine components
  if (msg.includes('[antd: Menu]') ||
      msg.includes('[antd: Drawer]') ||
      msg.includes('findDOMNode')) {
    return;
  }
  originalWarn.apply(console, args);
};

console.error = (...args: any[]) => {
  const msg = args[0]?.toString() || '';
  // Suppress Ant Design deprecation warnings from Refine components
  if (msg.includes('[antd: Menu]') ||
      msg.includes('[antd: Drawer]') ||
      msg.includes('findDOMNode') ||
      msg.includes('useForm')) {
    return;
  }
  originalError.apply(console, args);
};

// Validate environment variables
const warnings = validateEnv();
if (warnings.length > 0) {
  originalWarn('Environment Configuration Warnings:');
  warnings.forEach(warning => originalWarn(warning));
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
