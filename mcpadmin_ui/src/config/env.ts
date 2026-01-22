// Environment configuration
export const env = {
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:3000/api',
  apiKey: import.meta.env.VITE_SECONDARY_LAYER_KEY || '',
} as const;

// Validation
export const validateEnv = () => {
  const warnings: string[] = [];
  
  if (!env.apiKey) {
    warnings.push('⚠️  VITE_SECONDARY_LAYER_KEY is not set. API calls may fail.');
  }
  
  return warnings;
};
