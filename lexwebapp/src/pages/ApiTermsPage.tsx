import { KeyRound } from 'lucide-react';
import { LegalPageLayout } from '../components/LegalPageLayout';
import contentUk from '../content/legal/api-terms-uk.md?raw';
import contentEn from '../content/legal/api-terms-en.md?raw';

export function ApiTermsPage() {
  return (
    <LegalPageLayout
      icon={<KeyRound size={28} className="text-indigo-600" />}
      iconBgClass="bg-indigo-100"
      routePath="api-terms"
      contentUk={contentUk}
      contentEn={contentEn}
    />
  );
}
