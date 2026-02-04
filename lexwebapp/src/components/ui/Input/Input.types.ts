/**
 * Input Types
 */

import { InputHTMLAttributes, ReactNode } from 'react';

export type InputSize = 'sm' | 'md' | 'lg';
export type InputVariant = 'default' | 'filled' | 'flushed';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /**
   * Input size
   * @default 'md'
   */
  size?: InputSize;

  /**
   * Input variant
   * @default 'default'
   */
  variant?: InputVariant;

  /**
   * Label text
   */
  label?: string;

  /**
   * Error message
   */
  error?: string;

  /**
   * Helper text
   */
  helperText?: string;

  /**
   * Icon before input
   */
  leftIcon?: ReactNode;

  /**
   * Icon after input
   */
  rightIcon?: ReactNode;

  /**
   * Full width
   * @default false
   */
  fullWidth?: boolean;
}
