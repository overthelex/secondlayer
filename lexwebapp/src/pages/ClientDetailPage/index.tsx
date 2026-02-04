/**
 * Client Detail Page
 * Displays detailed information about a client
 */

import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ClientDetailPage as ClientDetailPageComponent } from '../../components/ClientDetailPage';
import { ROUTES } from '../../router/routes';

export function ClientDetailPage() {
  const location = useLocation();
  const navigate = useNavigate();

  // Get client data from location state
  const client = location.state?.client;

  const handleBack = () => {
    navigate(ROUTES.CLIENTS);
  };

  // If no client data in state, show error or fetch it
  if (!client) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-claude-subtext">Клієнт не знайдений</p>
          <button
            onClick={handleBack}
            className="mt-4 px-4 py-2 bg-claude-accent text-white rounded-lg"
          >
            Повернутися до списку
          </button>
        </div>
      </div>
    );
  }

  return <ClientDetailPageComponent client={client} onBack={handleBack} />;
}
