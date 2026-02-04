/**
 * Switch Component
 * Toggle switch with smooth animation
 */

import React from 'react';

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /**
   * Label text
   */
  label?: string;

  /**
   * Switch size
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ label, size = 'md', className = '', ...props }, ref) => {
    const id = props.id || `switch-${Math.random().toString(36).substr(2, 9)}`;

    const sizeClasses = {
      sm: { container: 'w-8 h-4', thumb: 'w-3 h-3', translate: 'translate-x-4' },
      md: { container: 'w-11 h-6', thumb: 'w-5 h-5', translate: 'translate-x-5' },
      lg: { container: 'w-14 h-8', thumb: 'w-7 h-7', translate: 'translate-x-6' },
    }[size];

    return (
      <div className="flex items-center">
        <div className="relative inline-block">
          <input
            ref={ref}
            type="checkbox"
            id={id}
            className="peer sr-only"
            {...props}
          />
          <label
            htmlFor={id}
            className={`
              block ${sizeClasses.container} rounded-full
              bg-gray-300 cursor-pointer transition-colors duration-200
              peer-checked:bg-claude-accent
              peer-disabled:bg-gray-200 peer-disabled:cursor-not-allowed
              peer-focus:ring-2 peer-focus:ring-claude-accent peer-focus:ring-offset-2
              ${className}
            `}
          >
            <span
              className={`
                absolute left-0.5 top-0.5 ${sizeClasses.thumb}
                bg-white rounded-full transition-transform duration-200
                peer-checked:${sizeClasses.translate}
              `}
            />
          </label>
        </div>

        {label && (
          <label htmlFor={id} className="ml-3 text-sm text-gray-700 cursor-pointer">
            {label}
          </label>
        )}
      </div>
    );
  }
);

Switch.displayName = 'Switch';
