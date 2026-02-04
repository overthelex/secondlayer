/**
 * Checkbox Component
 * Accessible checkbox with label support
 */

import React from 'react';
import { Check } from 'lucide-react';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /**
   * Label text
   */
  label?: string;

  /**
   * Error message
   */
  error?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, error, className = '', ...props }, ref) => {
    const id = props.id || `checkbox-${Math.random().toString(36).substr(2, 9)}`;

    return (
      <div className="flex items-start">
        <div className="relative flex items-center">
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
              flex items-center justify-center w-5 h-5 border-2 rounded
              transition-all duration-200 cursor-pointer
              ${error ? 'border-red-500' : 'border-gray-300'}
              peer-checked:bg-claude-accent peer-checked:border-claude-accent
              peer-disabled:bg-gray-100 peer-disabled:cursor-not-allowed
              peer-focus:ring-2 peer-focus:ring-claude-accent peer-focus:ring-offset-2
              ${className}
            `}
          >
            <Check
              size={14}
              className="text-white opacity-0 peer-checked:opacity-100 transition-opacity"
            />
          </label>
        </div>

        {label && (
          <label htmlFor={id} className="ml-2 text-sm text-gray-700 cursor-pointer">
            {label}
          </label>
        )}

        {error && <p className="mt-1 text-sm text-red-500">{error}</p>}
      </div>
    );
  }
);

Checkbox.displayName = 'Checkbox';
