/**
 * Badge Types
 */

import { ReactNode } from 'react';

export type BadgeVariant = 'default' | 'success' | 'error' | 'warning' | 'info';
export type BadgeSize = 'sm' | 'md' | 'lg';

export interface BadgeProps {
  /**
   * Badge variant
   * @default 'default'
   */
  variant?: BadgeVariant;

  /**
   * Badge size
   * @default 'md'
   */
  size?: BadgeSize;

  /**
   * Dot indicator
   * @default false
   */
  dot?: boolean;

  /**
   * Badge content
   */
  children: ReactNode;

  /**
   * Additional className
   */
  className?: string;
}
