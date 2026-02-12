/**
 * Matter Detail Page
 * Fetches matter by URL param
 */

import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MatterDetailPage as MatterDetailPageComponent } from '../../components/MatterDetailPage';
import { useMatter } from '../../hooks/queries/useMatters';
import { Spinner } from '../../components/ui/Spinner';
import { ROUTES } from '../../router/routes';

export function MatterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: matter, isLoading, error } = useMatter(id || '');

  const handleBack = () => {
    navigate(ROUTES.MATTERS);
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !matter) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-claude-subtext font-sans">Справу не знайдено</p>
          <button
            onClick={handleBack}
            className="mt-4 px-4 py-2 bg-claude-accent text-white rounded-lg font-sans text-sm"
          >
            Повернутися до списку
          </button>
        </div>
      </div>
    );
  }

  return <MatterDetailPageComponent matter={matter} onBack={handleBack} />;
}
