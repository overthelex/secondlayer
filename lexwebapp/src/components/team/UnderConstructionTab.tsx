/**
 * Under Construction Tab Component
 * Placeholder for future tabs in Team section
 */

import React from 'react';
import { Construction } from 'lucide-react';

export function UnderConstructionTab() {
  return (
    <div className="flex flex-col items-center justify-center py-24">
      <div className="mb-6">
        <Construction className="w-24 h-24 text-gray-300" />
      </div>
      <h3 className="text-2xl font-semibold text-gray-700 mb-2">
        В розробці
      </h3>
      <p className="text-gray-500 text-center max-w-md">
        Цей розділ знаходиться в розробці. Ми працюємо над тим, щоб
        зробити його доступним найближчим часом.
      </p>
    </div>
  );
}
