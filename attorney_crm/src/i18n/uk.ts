// The Ukrainian strings: exactly the text attorney.legal.org.ua has shown since 07.11.2026.
import type { Strings } from '../tenant/types';

export const uk: Strings = {
  nav: { today: 'Сьогодні', advocates: 'Адвокати', logout: 'Вийти' },
  brandTagline: 'CRM адвокатів',
  login: {
    title: 'Вхід', heading: 'Вхід для менеджерів', email: 'E-mail', password: 'Пароль', submit: 'Увійти',
    badCredentials: 'Невірний e-mail або пароль', blocked: 'Забагато спроб. Спробуйте за 15 хвилин.',
  },
  list: {
    title: 'Адвокати', countSuffix: 'діючих', surnameStartsWith: 'Прізвище починається з', surnamePlaceholder: 'Ков', city: 'Місто', region: 'Область', all: 'усі',
    derivedPractice: 'Вид права (ЄДРСР)', manualPractice: 'Практика (ручна)', declaredPractice: 'Практика (заявлена)', profession: 'Професія', stage: 'Стадія', show: 'Показати', reset: 'Скинути',
    contacts: 'Контакти', noContact: 'Контактів немає', orgColumn: 'Бюро / рада', certColumn: 'Свідоцтво', practicesColumn: 'Практики', casesColumn: 'Справ',
    casesFor: (name) => `Справ (${name})`, stageColumn: 'Стадія', nextContact: 'Наступний', lastContact: 'останній', contactWord: 'контакт', empty: 'Адвокатів не знайдено',
    prev: '← Попередня', next: 'Наступна →', pageOf: (page, pages, total) => `Сторінка ${page} з ${pages} (всього ${total})`, derivedTitle: 'справ у ЄДРСР',
  },
  detail: {
    back: '← Адвокати', registrySection: 'Реєстр НААУ', phone: 'Телефон', email: 'E-mail', address: 'Адреса', cityRegion: 'Місто / область', org: "Бюро / об'єднання", council: 'Рада адвокатів',
    certificate: 'Свідоцтво', decision: 'Рішення', authority: 'Орган', status: 'Статус', registryId: 'ID реєстру', from: 'від', practiceSection: 'Практика за ЄДРСР',
    noMentions: 'Згадок у рішеннях 2024–2026 ще не знайдено.', topCategories: 'Найчастіші категорії', declaredSection: 'Заявлені практики', declaredNone: 'Практик не заявлено.', otherTags: 'Інші теги', profileLink: 'Профіль у реєстрі',
    directoryLink: 'Профіль у довіднику', leadSection: 'Робота з лідом', stageField: 'Стадія', nextContactField: 'Наступний контакт', overdue: 'прострочено', manualTags: 'Практики (ручні теги)', save: 'Зберегти',
    notesSection: 'Нотатки', noteBody: 'Опис дзвінка, листа або зустрічі', addNote: 'Додати нотатку', noNotes: 'Нотаток ще немає.', doNotContact: 'Не турбувати', doNotContactReason: 'Причина',
    phoneOverride: 'Телефон (ручний)', emailOverride: 'E-mail (ручний)', manualMark: 'ручний', notFoundTitle: 'Не знайдено', notFoundHeading: 'Сторінку не знайдено', notFoundBody: (id) => `Адвоката з ID ${id} немає в реєстрі.`,
    suppressed: (reason, date) => `${reason} · ${date}`,
  },
  unsubscribe: {
    title: 'Відписка', heading: 'Відписатися від листів', body: (email) => `Ви більше не отримуватимете листи від legal.org.ua на адресу ${email}. Підтвердіть, будь ласка.`,
    confirm: 'Відписатися', doneHeading: 'Готово', doneBody: (email) => `Адресу ${email} вилучено з розсилки. Ми більше не писатимемо.`,
    invalidHeading: 'Посилання недійсне', invalidBody: 'Посилання пошкоджене або застаріло. Напишіть на unsubscribe@legal.org.ua, і ми вилучимо адресу вручну.',
  },
  suppressionReasons: { unsubscribe: 'Відписався', bounce: 'Відскок', complaint: 'Скарга на спам', manual: 'Не турбувати' },
  mailSentNote: (subject, campaign) => `Надіслано лист «${subject}»${campaign ? ` (розсилка ${campaign})` : ''}`,
  today: {
    title: 'Сьогодні', callToday: 'Подзвонити сьогодні', nothingDue: 'На сьогодні контактів не заплановано. Призначте дату на сторінці адвоката.', date: 'Дата', name: 'ПІБ', city: 'Місто', phone: 'Телефон', stage: 'Стадія', lastNote: 'Остання нотатка',
    newNotes: 'Нові нотатки', noNotes: 'Нотаток ще немає.', overdue: 'прострочено',
  },
  stages: { new: 'Новий', contacted: 'Контакт був', interested: 'Зацікавлений', declined: 'Відмовив', client: 'Клієнт' },
  noteKinds: { call: 'Дзвінок', email: 'Лист', meeting: 'Зустріч', other: 'Інше' },
  status: { active: 'Діє', suspended: 'Право зупинено', terminated: 'Право припинено' },
  profession: {},
  errors: {
    notFound: 'Не знайдено', serverError: 'Помилка', serverErrorHeading: 'Сталася помилка', serverErrorBody: 'Спробуйте ще раз за хвилину. Якщо повторюється, напишіть Володимиру.',
    unknownStage: (s) => `Невідома стадія: ${s}`, unknownPractice: (p) => `Невідома практика: ${p}`, unknownNoteKind: (k) => `Невідомий тип нотатки: ${k}`, emptyNote: 'Порожня нотатка',
  },
  pbx: {
    call: 'Подзвонити', callTitle: 'Спочатку задзвонить ваш телефон, потім АТС набере адвоката', incoming: 'Вхідний дзвінок', unknownCaller: 'невідомий номер', open: 'Відкрити картку',
    pbxError: 'АТС не відповідає. Спробуйте ще раз або подзвоніть з телефона.',
    badNumber: (raw) => `Не схоже на український номер: ${raw}`,
    outboundNote: (number, outcome, channelId) => `Дзвінок через АТС на ${number}: ${outcome} (id ${channelId})`,
    inboundNote: (number, outcome, channelId) => `Вхідний дзвінок з ${number}: ${outcome} (id ${channelId})`,
    duration: (m, s) => (m ? `${m} хв ${s} с` : `${s} с`),
    outcomes: {
      started: 'з’єднуємо', ringing: 'дзвонить', answered: 'розмова відбулася', busy: 'зайнято', no_answer: 'не відповіли', agent_no_answer: 'оператор не взяв слухавку',
      cancelled: 'скасовано', failed: 'не вдалося з’єднати', missed: 'пропущено',
    },
    status: { ringing_agent: 'Дзвонить ваш телефон…', dialing: 'Набираємо адвоката…', answered: 'Розмова', ended: 'Завершено' },
  },
};
