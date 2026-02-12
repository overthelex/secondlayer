/**
 * Matters Page
 * Wrapper for MattersPage component with routing logic
 */

import { useNavigate } from 'react-router-dom';
import { MattersPage as MattersPageComponent } from '../../components/MattersPage';
import { generateRoute } from '../../router/routes';

export function MattersPage() {
  const navigate = useNavigate();

  const handleSelectMatter = (matter: any) => {
    navigate(generateRoute.matterDetail(matter.id));
  };

  return <MattersPageComponent onSelectMatter={handleSelectMatter} />;
}
