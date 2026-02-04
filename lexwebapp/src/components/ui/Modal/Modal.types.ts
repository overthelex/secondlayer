/**
 * Modal Types
 */

import { ReactNode } from 'react';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ModalProps {
  /**
   * Modal open state
   */
  isOpen: boolean;

  /**
   * Close callback
   */
  onClose: () => void;

  /**
   * Modal title
   */
  title?: string;

  /**
   * Modal size
   * @default 'md'
   */
  size?: ModalSize;

  /**
   * Show close button
   * @default true
   */
  showCloseButton?: boolean;

  /**
   * Close on backdrop click
   * @default true
   */
  closeOnBackdrop?: boolean;

  /**
   * Modal content
   */
  children: ReactNode;
}
