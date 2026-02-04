/**
 * Judges Page
 * Wrapper for JudgesPage component with routing logic
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { JudgesPage as JudgesPageComponent } from '../../components/JudgesPage';
import { generateRoute } from '../../router/routes';

export function JudgesPage() {
  const navigate = useNavigate();

  const handleSelectJudge = (judge: any) => {
    navigate(generateRoute.judgeDetail(judge.id), {
      state: {
        person: {
          type: 'judge',
          data: {
            id: judge.id,
            name: judge.name,
            position: judge.court,
            cases: judge.cases,
            successRate: judge.approvalRate,
            specialization: judge.specialization,
          },
        },
      },
    });
  };

  return <JudgesPageComponent onSelectJudge={handleSelectJudge} />;
}
