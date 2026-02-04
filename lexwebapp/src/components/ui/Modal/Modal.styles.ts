/**
 * Modal Styles
 */

import { ModalSize } from './Modal.types';

interface GetModalClassesParams {
  size: ModalSize;
}

const baseClasses = 'bg-white rounded-lg shadow-xl w-full';

const sizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-full mx-4',
};

export function getModalClasses({ size }: GetModalClassesParams): string {
  return `${baseClasses} ${sizeClasses[size]}`;
}
