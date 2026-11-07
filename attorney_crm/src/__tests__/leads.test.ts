import { saveLead, addNote, listNotes, ValidationError } from '../leads/repo';

function fakePool(rows: Record<string, unknown>[] = []) {
  const calls: { text: string; values?: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  };
}

test('saveLead upserts so a first save creates the row', async () => {
  const pool = fakePool([{ advocate_source_id: '42', stage: 'contacted', next_contact_at: null, manual_practices: ['ДТП'], assigned_user_id: null, updated_at: new Date(), updated_by: 1 }]);
  const lead = await saveLead(pool as any, '42', { stage: 'contacted', manualPractices: ['ДТП'], nextContactAt: null }, 1);
  expect(pool.calls[0].text).toContain('INSERT INTO attorney_crm_leads');
  expect(pool.calls[0].text).toContain('ON CONFLICT (advocate_source_id) DO UPDATE');
  expect(pool.calls[0].values).toEqual(['42', 'contacted', null, ['ДТП'], 1, true]);
  expect(lead.stage).toBe('contacted');
});

test('saveLead without nextContactAt keeps the stored date (flag false)', async () => {
  const pool = fakePool([{ advocate_source_id: '42', stage: 'new', next_contact_at: null, manual_practices: [], assigned_user_id: null, updated_at: new Date(), updated_by: 1 }]);
  await saveLead(pool as any, '42', { stage: 'new' }, 1);
  expect(pool.calls[0].values![5]).toBe(false);
});

test('saveLead rejects an unknown practice and an unknown stage', async () => {
  const pool = fakePool();
  await expect(saveLead(pool as any, '42', { manualPractices: ['Космічне право'] }, 1)).rejects.toBeInstanceOf(ValidationError);
  await expect(saveLead(pool as any, '42', { stage: 'won' as any }, 1)).rejects.toBeInstanceOf(ValidationError);
  expect(pool.calls).toHaveLength(0);
});

test('addNote rejects a whitespace-only body and an unknown kind', async () => {
  const pool = fakePool();
  await expect(addNote(pool as any, '42', 1, 'call', '   \n')).rejects.toThrow('Порожня нотатка');
  await expect(addNote(pool as any, '42', 1, 'fax' as any, 'x')).rejects.toBeInstanceOf(ValidationError);
  expect(pool.calls).toHaveLength(0);
});

test('addNote inserts the trimmed body and listNotes orders newest first', async () => {
  const pool = fakePool([{ id: 1, advocate_source_id: '42', user_id: 1, kind: 'call', body: 'Подзвонив', created_at: new Date(), author: 'V' }]);
  const note = await addNote(pool as any, '42', 1, 'call', '  Подзвонив  ');
  expect(pool.calls[0].values).toEqual(['42', 1, 'call', 'Подзвонив']);
  expect(note.body).toBe('Подзвонив');
  await listNotes(pool as any, '42');
  expect(pool.calls[1].text).toContain('ORDER BY n.created_at DESC');
});

import { dueToday, recentNotes, endOfKyivDay } from '../leads/repo';

test('endOfKyivDay is the next Kyiv midnight in UTC', () => {
  // 07.11.2026 10:00 UTC → Kyiv (UTC+2) end of day = 08.11 00:00 Kyiv = 07.11 22:00 UTC
  expect(endOfKyivDay(new Date('2026-11-07T10:00:00Z')).toISOString()).toBe('2026-11-07T22:00:00.000Z');
  // summer: 01.07.2026 23:30 UTC is already 02.07 02:30 Kyiv (UTC+3) → 03.07 00:00 Kyiv = 02.07 21:00 UTC
  expect(endOfKyivDay(new Date('2026-07-01T23:30:00Z')).toISOString()).toBe('2026-07-02T21:00:00.000Z');
});

test('dueToday selects leads before end of today, overdue first', async () => {
  const pool = fakePool([{ advocate_source_id: '42', family_name: 'Коваль', first_name: 'Іван', patronymic: 'П', city: 'Київ', phone: '1', stage: 'contacted', next_contact_at: new Date('2026-11-01'), last_note: 'x', last_note_at: new Date() }]);
  const rows = await dueToday(pool as any, new Date('2026-11-07T10:00:00Z'));
  expect(pool.calls[0].text).toContain('l.next_contact_at < $1');
  expect(pool.calls[0].text).toContain('ORDER BY l.next_contact_at ASC');
  expect((pool.calls[0].values![0] as Date).toISOString()).toBe('2026-11-07T22:00:00.000Z');
  expect(rows[0]).toMatchObject({ sourceId: '42', fullName: 'Коваль Іван П', overdue: true });
});

test('recentNotes limits to 30 newest with author and advocate name', async () => {
  const pool = fakePool([]);
  await recentNotes(pool as any);
  expect(pool.calls[0].text).toContain('ORDER BY n.created_at DESC');
  expect(pool.calls[0].values).toEqual([30]);
  expect(pool.calls[0].text).toContain('opendata_advocates');
});
