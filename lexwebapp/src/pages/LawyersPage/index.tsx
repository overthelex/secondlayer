/**
 * Lawyers Page
 * Wrapper for LawyersPage component with routing logic
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { LawyersPage as LawyersPageComponent } from '../../components/LawyersPage';
import { generateRoute } from '../../router/routes';

export function LawyersPage() {
  const navigate = useNavigate();

  const handleSelectLawyer = (lawyer: any) => {
    navigate(generateRoute.lawyerDetail(lawyer.id), {
      state: {
        person: {
          type: 'lawyer',
          data: {
            id: lawyer.id,
            name: lawyer.name,
            position: lawyer.firm,
            cases: lawyer.cases,
            successRate: lawyer.successRate,
            specialization: lawyer.specialization,
          },
        },
      },
    });
  };

  return <LawyersPageComponent onSelectLawyer={handleSelectLawyer} />;
}
