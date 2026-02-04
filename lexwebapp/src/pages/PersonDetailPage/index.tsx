/**
 * Person Detail Page
 * Displays details for a judge or lawyer
 */

import React from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { PersonDetailPage as PersonDetailPageComponent } from '../../components/PersonDetailPage';
import { ROUTES } from '../../router/routes';

interface PersonDetailPageProps {
  type: 'judge' | 'lawyer';
}

export function PersonDetailPage({ type }: PersonDetailPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  // Get person data from location state or fetch it based on ID
  const person = location.state?.person?.data;

  const handleBack = () => {
    if (type === 'judge') {
      navigate(ROUTES.JUDGES);
    } else {
      navigate(ROUTES.LAWYERS);
    }
  };

  // If no person data in state, could fetch it here based on ID
  if (!person) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-claude-subtext">Завантаження...</p>
          <button
            onClick={handleBack}
            className="mt-4 px-4 py-2 bg-claude-accent text-white rounded-lg"
          >
            Повернутися назад
          </button>
        </div>
      </div>
    );
  }

  return (
    <PersonDetailPageComponent
      type={type}
      person={person}
      onBack={handleBack}
    />
  );
}
