/**
 * Clients Page
 * Wrapper for ClientsPage component with routing logic
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ClientsPage as ClientsPageComponent } from '../../components/ClientsPage';
import { generateRoute, ROUTES } from '../../router/routes';

export function ClientsPage() {
  const navigate = useNavigate();

  const handleSelectClient = (client: any) => {
    navigate(generateRoute.clientDetail(client.id), {
      state: { client },
    });
  };

  const handleSendMessage = (clientIds: string[]) => {
    navigate(ROUTES.CLIENT_MESSAGING, {
      state: { clientIds },
    });
  };

  return (
    <ClientsPageComponent
      onSelectClient={handleSelectClient}
      onSendMessage={handleSendMessage}
    />
  );
}
