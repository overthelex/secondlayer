/**
 * Button Styles
 * Style utilities for Button component
 */

import { ButtonVariant, ButtonSize } from './Button.types';

interface GetButtonClassesParams {
  variant: ButtonVariant;
  size: ButtonSize;
  fullWidth: boolean;
  disabled: boolean;
  className?: string;
}

const baseClasses =
  'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2';

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-claude-accent text-white hover:bg-opacity-90 focus:ring-claude-accent disabled:bg-gray-300 disabled:cursor-not-allowed',
  secondary:
    'bg-gray-100 text-gray-900 hover:bg-gray-200 focus:ring-gray-400 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed',
  outline:
    'border-2 border-claude-accent text-claude-accent hover:bg-claude-accent hover:text-white focus:ring-claude-accent disabled:border-gray-300 disabled:text-gray-300 disabled:cursor-not-allowed',
  ghost:
    'text-gray-700 hover:bg-gray-100 focus:ring-gray-400 disabled:text-gray-400 disabled:cursor-not-allowed',
  danger:
    'bg-red-500 text-white hover:bg-red-600 focus:ring-red-500 disabled:bg-red-300 disabled:cursor-not-allowed',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-6 py-3 text-lg',
};

export function getButtonClasses({
  variant,
  size,
  fullWidth,
  disabled,
  className,
}: GetButtonClassesParams): string {
  const classes = [
    baseClasses,
    variantClasses[variant],
    sizeClasses[size],
    fullWidth ? 'w-full' : '',
    disabled ? 'opacity-60' : '',
    className,
  ];

  return classes.filter(Boolean).join(' ');
}
