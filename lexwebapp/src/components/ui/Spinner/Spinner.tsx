/**
 * Spinner Component
 * Loading spinner with sizes and colors
 */

import React from 'react';
import { Loader } from 'lucide-react';

export interface SpinnerProps {
  /**
   * Spinner size
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg' | 'xl';

  /**
   * Spinner color
   * @default 'primary'
   */
  color?: 'primary' | 'white' | 'gray';

  /**
   * Additional className
   */
  className?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({
  size = 'md',
  color = 'primary',
  className = '',
}) => {
  const sizeMap = {
    sm: 16,
    md: 24,
    lg: 32,
    xl: 48,
  };

  const colorMap = {
    primary: 'text-claude-accent',
    white: 'text-white',
    gray: 'text-gray-500',
  };

  return (
    <Loader
      size={sizeMap[size]}
      className={`animate-spin ${colorMap[color]} ${className}`}
    />
  );
};
