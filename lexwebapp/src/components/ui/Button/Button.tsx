/**
 * Button Component
 * Reusable button with variants, sizes, and loading state
 */

import React from 'react';
import { Loader } from 'lucide-react';
import { ButtonProps } from './Button.types';
import { getButtonClasses } from './Button.styles';

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      isLoading = false,
      disabled = false,
      fullWidth = false,
      leftIcon,
      rightIcon,
      children,
      className = '',
      ...props
    },
    ref
  ) => {
    const classes = getButtonClasses({
      variant,
      size,
      fullWidth,
      disabled: disabled || isLoading,
      className,
    });

    return (
      <button
        ref={ref}
        className={classes}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && (
          <Loader className="animate-spin" size={size === 'sm' ? 14 : 16} />
        )}
        {!isLoading && leftIcon && leftIcon}
        <span>{children}</span>
        {!isLoading && rightIcon && rightIcon}
      </button>
    );
  }
);

Button.displayName = 'Button';
