import { createMailer } from '../mail/sender';
import { signUnsubscribeToken } from '../mail/token';

type Row = Record<string, unknown>;

function fakePool(handler: (text: string, values?: unknown[]) => Row[] | undefined = () => undefined) {
  const calls: { text: string; values?: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      const rows = handler(text, values) ?? [];
      return { rows, rowCount: rows.length };
    },
  };
}

const cfg = {
  smtpUrl: null,
  from: 'legal.org.ua <vladimir@legal.org.ua>',
  unsubscribe: { publicUrl: 'https://attorney.legal.org.ua', mailbox: 'unsubscribe@legal.org.ua', secret: 's' },
};

test('a dry run builds the message with List-Unsubscribe headers and logs it as dry-run', async () => {
  const pool = fakePool();
  const mailer = createMailer(pool as any, cfg);
  const res = await mailer.send({ to: 'Adv@Example.UA', subject: 'Привіт', text: 'Текст листа', advocateSourceId: '42', campaign: 'nov' });
  expect(res.status).toBe('dry-run');
  expect(res.email).toBe('adv@example.ua');
  // Long headers are folded (RFC 5322 §2.2.3); unfold before matching.
  const raw = res.raw!.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const token = signUnsubscribeToken('s', 'adv@example.ua');
  expect(raw).toContain(`List-Unsubscribe: <mailto:unsubscribe@legal.org.ua?subject=unsubscribe%20${token}>, <https://attorney.legal.org.ua/u/${token}>`);
  expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  expect(raw).toContain('Precedence: bulk');
  expect(raw).toContain('To: adv@example.ua');
  const logged = pool.calls.find((c) => c.text.includes('INSERT INTO attorney_crm_mail_log'));
  expect(logged?.values).toEqual(['adv@example.ua', '42', 'nov', 'Привіт', expect.any(String), 'dry-run', null]);
  mailer.close();
});

test('a suppressed address is never handed to the transport', async () => {
  const pool = fakePool((t, v) => (t.includes('FROM attorney_crm_suppression') ? [{ email: String(v?.[0]) === 'a@b.ua' ? 'a@b.ua' : '' }].filter((r) => r.email) : undefined));
  const sendMail = jest.fn();
  const mailer = createMailer(pool as any, cfg, { sendMail, close: jest.fn() } as any);
  const res = await mailer.send({ to: 'a@b.ua', subject: 's', text: 't' });
  expect(res.status).toBe('suppressed');
  expect(sendMail).not.toHaveBeenCalled();
  const logged = pool.calls.find((c) => c.text.includes('INSERT INTO attorney_crm_mail_log'));
  expect(logged?.values?.[5]).toBe('suppressed');
});

test('a lead marked do-not-contact is suppressed even without a suppression row', async () => {
  const pool = fakePool((t) => (t.includes('SELECT do_not_contact FROM attorney_crm_leads') ? [{ do_not_contact: true }] : undefined));
  const sendMail = jest.fn();
  const mailer = createMailer(pool as any, cfg, { sendMail, close: jest.fn() } as any);
  const res = await mailer.send({ to: 'a@b.ua', subject: 's', text: 't', advocateSourceId: '7' });
  expect(res.status).toBe('suppressed');
  expect(res.error).toBe('do_not_contact');
  expect(sendMail).not.toHaveBeenCalled();
});

test('a second send in the same campaign is a duplicate and is not resent', async () => {
  const pool = fakePool((t) => (t.includes('FROM attorney_crm_mail_log WHERE campaign') ? [{ n: '1' }] : undefined));
  const sendMail = jest.fn();
  const mailer = createMailer(pool as any, cfg, { sendMail, close: jest.fn() } as any);
  const res = await mailer.send({ to: 'a@b.ua', subject: 's', text: 't', campaign: 'nov' });
  expect(res.status).toBe('duplicate');
  expect(sendMail).not.toHaveBeenCalled();
  expect(pool.calls.some((c) => c.text.includes('INSERT INTO attorney_crm_mail_log'))).toBe(false);
});

test('a transport failure is logged as failed with the error', async () => {
  const pool = fakePool();
  const sendMail = jest.fn().mockRejectedValue(new Error('451 4.7.0 rate limited'));
  const mailer = createMailer(pool as any, { ...cfg, smtpUrl: 'smtp://x' }, { sendMail, close: jest.fn() } as any);
  const res = await mailer.send({ to: 'a@b.ua', subject: 's', text: 't' });
  expect(res.status).toBe('failed');
  expect(res.error).toContain('rate limited');
  const logged = pool.calls.find((c) => c.text.includes('INSERT INTO attorney_crm_mail_log'));
  expect(logged?.values?.slice(5)).toEqual(['failed', '451 4.7.0 rate limited']);
});

test('a real transport result is logged as sent with its message id', async () => {
  const pool = fakePool();
  const sendMail = jest.fn().mockResolvedValue({ messageId: '<id@legal.org.ua>' });
  const mailer = createMailer(pool as any, { ...cfg, smtpUrl: 'smtp://x' }, { sendMail, close: jest.fn() } as any);
  const res = await mailer.send({ to: 'a@b.ua', subject: 's', text: 't' });
  expect(res).toEqual({ status: 'sent', email: 'a@b.ua', messageId: '<id@legal.org.ua>', raw: undefined });
  expect(sendMail.mock.calls[0][0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  expect(sendMail.mock.calls[0][0].from).toBe(cfg.from);
});
