/**
 * Organization Setup Modal
 * Prompts user to create their organization after login
 */

import React, { useState } from 'react';
import { Modal } from '../ui/Modal/Modal';
import { api } from '../../utils/api-client';
import toast from 'react-hot-toast';

interface OrganizationSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
  userEmail?: string;
}

export const OrganizationSetupModal: React.FC<OrganizationSetupModalProps> = ({
  isOpen,
  onClose,
  onCreated,
  userEmail,
}) => {
  const [name, setName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [contactEmail, setContactEmail] = useState(userEmail || '');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSkip = () => {
    sessionStorage.setItem('org_setup_skipped', '1');
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error('Введіть назву організації');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.team.createOrganization({
        name: name.trim(),
        taxId: taxId.trim() || undefined,
        contactEmail: contactEmail.trim() || undefined,
        description: description.trim() || undefined,
      });

      toast.success('Організацію створено');
      onCreated();
    } catch (error: any) {
      const message = error?.response?.data?.error || 'Не вдалося створити організацію';
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleSkip}
      title="Налаштування організації"
      size="md"
      closeOnBackdrop={false}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-gray-500 mb-4">
          Створіть організацію для роботи з документами та справами.
        </p>

        {/* Company Name */}
        <div>
          <label htmlFor="org-name" className="block text-sm font-medium text-gray-700 mb-1">
            Назва компанії <span className="text-red-500">*</span>
          </label>
          <input
            id="org-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ТОВ «Юридична компанія»"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent focus:border-transparent"
            autoFocus
          />
        </div>

        {/* Tax ID */}
        <div>
          <label htmlFor="org-tax-id" className="block text-sm font-medium text-gray-700 mb-1">
            ЄДРПОУ
          </label>
          <input
            id="org-tax-id"
            type="text"
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            placeholder="12345678"
            maxLength={10}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent focus:border-transparent"
          />
        </div>

        {/* Contact Email */}
        <div>
          <label htmlFor="org-email" className="block text-sm font-medium text-gray-700 mb-1">
            Контактний email
          </label>
          <input
            id="org-email"
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="office@company.ua"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent focus:border-transparent"
          />
        </div>

        {/* Description */}
        <div>
          <label htmlFor="org-description" className="block text-sm font-medium text-gray-700 mb-1">
            Опис
          </label>
          <textarea
            id="org-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Коротко про діяльність компанії"
            rows={2}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent focus:border-transparent resize-none"
          />
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={handleSkip}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Пропустити
          </button>
          <button
            type="submit"
            disabled={isSubmitting || !name.trim()}
            className="px-4 py-2 text-sm text-white bg-claude-accent hover:bg-claude-accent/90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Збереження...' : 'Зберегти'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
