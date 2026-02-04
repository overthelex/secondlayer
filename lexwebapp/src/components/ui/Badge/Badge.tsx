/**
 * Badge Component
 * Status badges with variants and sizes
 */

import React from 'react';
import { BadgeProps } from './Badge.types';
import { getBadgeClasses } from './Badge.styles';

export const Badge: React.FC<BadgeProps> = ({
  variant = 'default',
  size = 'md',
  dot = false,
  children,
  className = '',
}) => {
  const classes = getBadgeClasses({ variant, size, className });

  return (
    <span className={classes}>
      {dot && (
        <span className="inline-block w-2 h-2 rounded-full bg-current mr-1.5" />
      )}
      {children}
    </span>
  );
};
