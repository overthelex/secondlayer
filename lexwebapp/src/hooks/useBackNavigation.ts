/**
 * useBackNavigation Hook
 * Provides consistent back navigation functionality
 * Uses provided onBack callback or falls back to browser history
 */

import { useNavigate } from 'react-router-dom';

export function useBackNavigation(onBack?: () => void) {
  const navigate = useNavigate();

  return () => {
    if (onBack) {
      onBack();
    } else {
      navigate(-1);
    }
  };
}
