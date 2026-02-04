/**
 * Card Styles
 */

import { CardVariant } from './Card.types';

interface GetCardClassesParams {
  variant: CardVariant;
  hoverable: boolean;
  className?: string;
}

const baseClasses = 'rounded-lg overflow-hidden transition-all duration-200';

const variantClasses: Record<CardVariant, string> = {
  default: 'bg-white',
  outlined: 'bg-white border border-gray-200',
  elevated: 'bg-white shadow-md',
};

export function getCardClasses({
  variant,
  hoverable,
  className,
}: GetCardClassesParams): string {
  const classes = [
    baseClasses,
    variantClasses[variant],
    hoverable ? 'hover:shadow-lg cursor-pointer' : '',
    className,
  ];

  return classes.filter(Boolean).join(' ');
}
