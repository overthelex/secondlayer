import type { Strings } from '../tenant/types';

export const en: Strings = {
  nav: { today: 'Today', advocates: 'Lawyers', logout: 'Sign out' },
  brandTagline: 'Lawyer CRM',
  login: {
    title: 'Sign in', heading: 'Sign in for managers', email: 'E-mail', password: 'Password', submit: 'Sign in',
    badCredentials: 'Wrong e-mail or password', blocked: 'Too many attempts. Try again in 15 minutes.',
  },
  list: {
    title: 'Lawyers', countSuffix: 'practising', surnameStartsWith: 'Surname starts with', surnamePlaceholder: 'Kow', city: 'Town', region: 'Chamber', all: 'all',
    derivedPractice: 'Practice area (courts)', manualPractice: 'Practice area (manual)', declaredPractice: 'Practice area', profession: 'Profession', stage: 'Stage', show: 'Show', reset: 'Reset',
    contacts: 'Contacts', noContact: 'No public contact', orgColumn: 'Office', certColumn: 'Entry no.', practicesColumn: 'Practice areas', casesColumn: 'Cases',
    casesFor: (name) => `Cases (${name})`, stageColumn: 'Stage', nextContact: 'Next', lastContact: 'last', contactWord: 'contact', empty: 'No lawyers found',
    prev: '← Previous', next: 'Next →', pageOf: (page, pages, total) => `Page ${page} of ${pages} (${total} in total)`, derivedTitle: 'court cases',
  },
  detail: {
    back: '← Lawyers', registrySection: 'Register', phone: 'Phone', email: 'E-mail', address: 'Address', cityRegion: 'Town / chamber', org: 'Office', council: 'Chamber',
    certificate: 'Entry no.', decision: 'Decision', authority: 'Authority', status: 'Status', registryId: 'Register ID', from: 'of', practiceSection: 'Court practice',
    noMentions: 'No court mentions found yet.', topCategories: 'Most frequent categories', declaredSection: 'Declared practice areas', declaredNone: 'No practice areas declared.', otherTags: 'Other tags', profileLink: 'Register profile',
    directoryLink: 'Directory profile', leadSection: 'Lead', stageField: 'Stage', nextContactField: 'Next contact', overdue: 'overdue', manualTags: 'Practice areas (manual tags)', save: 'Save',
    notesSection: 'Notes', noteBody: 'What was said in the call, e-mail or meeting', addNote: 'Add note', noNotes: 'No notes yet.', doNotContact: 'Do not contact', doNotContactReason: 'Reason',
    phoneOverride: 'Phone (manual)', emailOverride: 'E-mail (manual)', manualMark: 'manual', notFoundTitle: 'Not found', notFoundHeading: 'Page not found', notFoundBody: (id) => `No lawyer with ID ${id} in the register.`,
    suppressed: (reason, date) => `${reason} · ${date}`,
  },
  unsubscribe: {
    title: 'Unsubscribe', heading: 'Unsubscribe from our e-mails', body: (email) => `You will no longer receive e-mails from lawrider at ${email}. Please confirm.`,
    confirm: 'Unsubscribe', doneHeading: 'Done', doneBody: (email) => `${email} has been removed from our mailing list. We will not write again.`,
    invalidHeading: 'Invalid link', invalidBody: 'This link is broken or has expired. Write to unsubscribe@lawrider.pl and we will remove the address by hand.',
  },
  suppressionReasons: { unsubscribe: 'Unsubscribed', bounce: 'Bounced', complaint: 'Spam complaint', manual: 'Do not contact' },
  mailSentNote: (subject, campaign) => `E-mail sent: "${subject}"${campaign ? ` (campaign ${campaign})` : ''}`,
  today: {
    title: 'Today', callToday: 'Call today', nothingDue: 'Nothing scheduled for today. Set a date on a lawyer page.', date: 'Date', name: 'Name', city: 'Town', phone: 'Phone', stage: 'Stage', lastNote: 'Last note',
    newNotes: 'New notes', noNotes: 'No notes yet.', overdue: 'overdue',
  },
  stages: { new: 'New', contacted: 'Contacted', interested: 'Interested', declined: 'Declined', client: 'Client' },
  noteKinds: { call: 'Call', email: 'E-mail', meeting: 'Meeting', other: 'Other' },
  status: { active: 'Practising', inactive: 'Not practising', former: 'Former', suspended: 'Suspended', terminated: 'Terminated' },
  profession: { adwokat: 'Adwokat', radca: 'Radca prawny' },
  errors: {
    notFound: 'Not found', serverError: 'Error', serverErrorHeading: 'Something went wrong', serverErrorBody: 'Try again in a minute. If it keeps happening, write to Vladimir.',
    unknownStage: (s) => `Unknown stage: ${s}`, unknownPractice: (p) => `Unknown practice area: ${p}`, unknownNoteKind: (k) => `Unknown note kind: ${k}`, emptyNote: 'Empty note',
  },
  pbx: {
    call: 'Call', callTitle: 'Your phone rings first, then the PBX dials the lawyer', incoming: 'Incoming call', unknownCaller: 'unknown number', open: 'Open the card',
    pbxError: 'The PBX is not answering. Try again or call from your phone.',
    badNumber: (raw) => `Does not look like a dialable number: ${raw}`,
    outboundNote: (number, outcome, channelId) => `PBX call to ${number}: ${outcome} (id ${channelId})`,
    inboundNote: (number, outcome, channelId) => `Inbound call from ${number}: ${outcome} (id ${channelId})`,
    duration: (m, s) => (m ? `${m} min ${s} s` : `${s} s`),
    outcomes: {
      started: 'connecting', ringing: 'ringing', answered: 'answered', busy: 'busy', no_answer: 'no answer', agent_no_answer: 'the operator did not pick up',
      cancelled: 'cancelled', failed: 'could not connect', missed: 'missed',
    },
    status: { ringing_agent: 'Your phone is ringing…', dialing: 'Dialling the lawyer…', answered: 'In call', ended: 'Ended' },
  },
};
