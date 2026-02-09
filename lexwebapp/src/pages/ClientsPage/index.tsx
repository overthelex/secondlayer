/**
 * Clients Page
 * Wrapper for ClientsPage component with routing logic
 */

import { useNavigate } from 'react-router-dom';
import { ClientsPage as ClientsPageComponent } from '../../components/ClientsPage';
import { generateRoute } from '../../router/routes';

export function ClientsPage() {
  const navigate = useNavigate();

  const handleSelectClient = (client: any) => {
    navigate(generateRoute.clientDetail(client.id), {
      state: { client },
    });
  };

  return (
    <ClientsPageComponent
      onSelectClient={handleSelectClient}
    />
  );
}
