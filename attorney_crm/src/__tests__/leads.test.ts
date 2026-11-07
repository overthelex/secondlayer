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
