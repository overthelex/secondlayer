/**
 * Input Styles
 */

import { InputSize, InputVariant } from './Input.types';

interface GetInputClassesParams {
  size: InputSize;
  variant: InputVariant;
  error: boolean;
  disabled: boolean;
  hasLeftIcon: boolean;
  hasRightIcon: boolean;
  className?: string;
}

interface GetContainerClassesParams {
  fullWidth: boolean;
}

const baseClasses =
  'w-full rounded-lg transition-all duration-200 focus:outline-none focus:ring-2';

const sizeClasses: Record<InputSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-5 py-3 text-lg',
};

const variantClasses: Record<InputVariant, string> = {
  default: 'border border-gray-300 bg-white focus:ring-claude-accent focus:border-claude-accent',
  filled: 'border-0 bg-gray-100 focus:ring-claude-accent focus:bg-white',
  flushed: 'border-0 border-b-2 border-gray-300 rounded-none px-0 focus:ring-0 focus:border-claude-accent',
};

export function getInputClasses({
  size,
  variant,
  error,
  disabled,
  hasLeftIcon,
  hasRightIcon,
  className,
}: GetInputClassesParams): string {
  const classes = [
    baseClasses,
    sizeClasses[size],
    variantClasses[variant],
    error ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : '',
    disabled ? 'bg-gray-100 cursor-not-allowed opacity-60' : '',
    hasLeftIcon ? 'pl-10' : '',
    hasRightIcon ? 'pr-10' : '',
    className,
  ];

  return classes.filter(Boolean).join(' ');
}

export function getContainerClasses({
  fullWidth,
}: GetContainerClassesParams): string {
  return fullWidth ? 'w-full' : '';
}
