/**
 * Client Messaging Page
 * Send messages to selected clients
 */

import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ClientMessagingPage as ClientMessagingPageComponent } from '../../components/ClientMessagingPage';
import { ROUTES } from '../../router/routes';

export function ClientMessagingPage() {
  const location = useLocation();
  const navigate = useNavigate();

  // Get client IDs from location state
  const clientIds = location.state?.clientIds || [];

  const handleBack = () => {
    navigate(ROUTES.CLIENTS);
  };

  return (
    <ClientMessagingPageComponent clientIds={clientIds} onBack={handleBack} />
  );
}
