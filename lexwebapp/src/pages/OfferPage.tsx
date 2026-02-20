/**
 * Public Offer (Оферта) Page
 * Fondy requires this URL with {lang} parameter: /uk/offer or /en/offer
 */

import { useParams, useNavigate } from 'react-router-dom';
import { FileText, ArrowLeft, Globe } from 'lucide-react';

const offerContent = {
  uk: {
    title: 'Публічна оферта',
    subtitle: 'Договір публічної оферти про надання послуг',
    effectiveDate: 'Дата набрання чинності: 14 лютого 2026 р.',
    backLabel: 'Назад',
    switchLang: 'English',
    switchTo: 'en',
    sections: [
      {
        heading: '1. Загальні положення',
        content: `1.1. Цей документ є офіційною публічною офертою (далі — «Оферта») платформи SecondLayer (далі — «Виконавець»), адресованою будь-якій фізичній або юридичній особі (далі — «Замовник»), яка приймає умови цієї Оферти.

1.2. Оферта вважається прийнятою (акцептованою) з моменту оплати послуг Замовником через платіжну систему Monobank або іншим доступним способом.

1.3. Виконавець залишає за собою право змінювати умови цієї Оферти без попереднього повідомлення. Актуальна версія Оферти завжди доступна за цією адресою.`,
      },
      {
        heading: '2. Предмет оферти',
        content: `2.1. Виконавець надає Замовнику доступ до онлайн-платформи SecondLayer для юридичного аналізу, пошуку судових рішень, аналізу законодавства та інших юридичних послуг (далі — «Послуги»).

2.2. Перелік та обсяг Послуг визначаються обраним тарифним планом та доступним балансом на рахунку Замовника.

2.3. Послуги надаються на умовах «як є» (as is). Результати аналізу мають інформаційний характер і не є юридичною консультацією.`,
      },
      {
        heading: '3. Вартість послуг та порядок оплати',
        content: `3.1. Вартість Послуг визначається відповідно до діючих тарифів, опублікованих на платформі.

3.2. Оплата здійснюється шляхом поповнення балансу через платіжну систему Monobank (в гривнях) або MetaMask (криптовалюта).

3.3. Кошти списуються з балансу Замовника відповідно до фактичного використання Послуг.

3.4. Повернення коштів здійснюється відповідно до чинного законодавства України та політики повернення Виконавця.`,
      },
      {
        heading: '4. Права та обов\'язки сторін',
        content: `4.1. Виконавець зобов\'язується:
— забезпечити доступ до платформи 24/7, за винятком планових технічних робіт;
— зберігати конфіденційність даних Замовника відповідно до Політики конфіденційності;
— надавати технічну підтримку.

4.2. Замовник зобов\'язується:
— надати достовірну інформацію при реєстрації;
— не передавати доступ до свого облікового запису третім особам;
— використовувати платформу відповідно до чинного законодавства.`,
      },
      {
        heading: '5. Відповідальність',
        content: `5.1. Виконавець не несе відповідальності за рішення, прийняті Замовником на основі результатів аналізу, наданих платформою.

5.2. Максимальна відповідальність Виконавця обмежується сумою оплати, здійсненої Замовником за останні 30 днів.

5.3. Виконавець не несе відповідальності за збої, спричинені форс-мажорними обставинами або діями третіх осіб.`,
      },
      {
        heading: '6. Персональні дані та конфіденційність',
        content: `6.1. Виконавець збирає та обробляє персональні дані Замовника відповідно до Закону України «Про захист персональних даних» та Регламенту GDPR.

6.2. Замовник надає згоду на обробку персональних даних шляхом акцепту цієї Оферти.

6.3. Виконавець не передає персональні дані третім особам, за винятком випадків, передбачених законодавством.`,
      },
      {
        heading: '7. Строк дії та розірвання',
        content: `7.1. Ця Оферта діє безстроково з моменту її акцепту.

7.2. Замовник може відмовитися від Послуг у будь-який час, звернувшись до служби підтримки.

7.3. Виконавець має право припинити надання Послуг у разі порушення Замовником умов цієї Оферти.`,
      },
      {
        heading: '8. Реквізити Виконавця',
        content: `SecondLayer
Електронна пошта: support@legal.org.ua
Веб-сайт: https://legal.org.ua`,
      },
    ],
  },
  en: {
    title: 'Public Offer',
    subtitle: 'Public Offer Agreement for Provision of Services',
    effectiveDate: 'Effective Date: February 14, 2026',
    backLabel: 'Back',
    switchLang: 'Українська',
    switchTo: 'uk',
    sections: [
      {
        heading: '1. General Provisions',
        content: `1.1. This document constitutes an official public offer (hereinafter — "Offer") of the SecondLayer platform (hereinafter — "Provider"), addressed to any individual or legal entity (hereinafter — "Client") who accepts the terms of this Offer.

1.2. The Offer is considered accepted from the moment of payment by the Client through the Monobank payment system or any other available method.

1.3. The Provider reserves the right to amend the terms of this Offer without prior notice. The current version of the Offer is always available at this address.`,
      },
      {
        heading: '2. Subject of the Offer',
        content: `2.1. The Provider grants the Client access to the SecondLayer online platform for legal analysis, court decision search, legislation analysis, and other legal services (hereinafter — "Services").

2.2. The scope of Services is determined by the selected pricing plan and the available balance in the Client's account.

2.3. Services are provided on an "as is" basis. Analysis results are informational in nature and do not constitute legal advice.`,
      },
      {
        heading: '3. Pricing and Payment',
        content: `3.1. The cost of Services is determined according to the current pricing published on the platform.

3.2. Payment is made by topping up the balance through the Monobank payment system (in Ukrainian hryvnias) or MetaMask (cryptocurrency).

3.3. Funds are deducted from the Client's balance according to actual usage of Services.

3.4. Refunds are processed in accordance with the current legislation of Ukraine and the Provider's refund policy.`,
      },
      {
        heading: '4. Rights and Obligations',
        content: `4.1. The Provider undertakes to:
— ensure platform availability 24/7, except for scheduled maintenance;
— maintain the confidentiality of Client data in accordance with the Privacy Policy;
— provide technical support.

4.2. The Client undertakes to:
— provide accurate information during registration;
— not share access to their account with third parties;
— use the platform in compliance with applicable laws.`,
      },
      {
        heading: '5. Liability',
        content: `5.1. The Provider is not liable for decisions made by the Client based on analysis results provided by the platform.

5.2. The Provider's maximum liability is limited to the amount paid by the Client in the last 30 days.

5.3. The Provider is not liable for failures caused by force majeure or actions of third parties.`,
      },
      {
        heading: '6. Personal Data and Privacy',
        content: `6.1. The Provider collects and processes the Client's personal data in accordance with the Law of Ukraine "On Protection of Personal Data" and the GDPR.

6.2. The Client consents to the processing of personal data by accepting this Offer.

6.3. The Provider does not share personal data with third parties, except as required by law.`,
      },
      {
        heading: '7. Duration and Termination',
        content: `7.1. This Offer is valid indefinitely from the moment of acceptance.

7.2. The Client may discontinue the Services at any time by contacting support.

7.3. The Provider may terminate the Services if the Client violates the terms of this Offer.`,
      },
      {
        heading: '8. Provider Details',
        content: `SecondLayer
Email: support@legal.org.ua
Website: https://legal.org.ua`,
      },
    ],
  },
};

export function OfferPage() {
  const { lang } = useParams<{ lang: string }>();
  const navigate = useNavigate();

  const currentLang = lang === 'uk' || lang === 'en' ? lang : 'uk';
  const content = offerContent[currentLang];

  const handleSwitchLang = () => {
    navigate(`/${content.switchTo}/offer`, { replace: true });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors text-sm"
          >
            <ArrowLeft size={16} />
            {content.backLabel}
          </button>

          <button
            onClick={handleSwitchLang}
            className="flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors text-gray-700"
          >
            <Globe size={14} />
            {content.switchLang}
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 md:p-12">
          {/* Title */}
          <div className="text-center mb-10">
            <div className="flex justify-center mb-4">
              <div className="w-14 h-14 bg-blue-100 rounded-full flex items-center justify-center">
                <FileText size={28} className="text-blue-600" />
              </div>
            </div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">{content.title}</h1>
            <p className="text-lg text-gray-600">{content.subtitle}</p>
            <p className="text-sm text-gray-400 mt-2">{content.effectiveDate}</p>
          </div>

          {/* Sections */}
          <div className="space-y-8">
            {content.sections.map((section, index) => (
              <section key={index}>
                <h2 className="text-xl font-semibold text-gray-900 mb-3">
                  {section.heading}
                </h2>
                <div className="text-gray-700 leading-relaxed whitespace-pre-line">
                  {section.content}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-4xl mx-auto px-4 py-6 text-center">
        <p className="text-xs text-gray-400">
          SecondLayer &copy; {new Date().getFullYear()}
        </p>
      </footer>
    </div>
  );
}
