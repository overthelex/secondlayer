/**
 * Badge Styles
 */

import { BadgeVariant, BadgeSize } from './Badge.types';

interface GetBadgeClassesParams {
  variant: BadgeVariant;
  size: BadgeSize;
  className?: string;
}

const baseClasses = 'inline-flex items-center font-medium rounded-full';

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-gray-100 text-gray-800',
  success: 'bg-green-100 text-green-800',
  error: 'bg-red-100 text-red-800',
  warning: 'bg-yellow-100 text-yellow-800',
  info: 'bg-blue-100 text-blue-800',
};

const sizeClasses: Record<BadgeSize, string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
  lg: 'px-3 py-1.5 text-base',
};

export function getBadgeClasses({
  variant,
  size,
  className,
}: GetBadgeClassesParams): string {
  const classes = [
    baseClasses,
    variantClasses[variant],
    sizeClasses[size],
    className,
  ];

  return classes.filter(Boolean).join(' ');
}
