/**
 * Welcome bonus claims held for review: the new claim looks like an earlier
 * claimant (same profile name, browser or recent IP). The admin compares the
 * two accounts and approves (bonus credited) or rejects.
 */

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../utils/api-client';

interface PendingClaim {
  user_id: string;
  email: string;
  name: string | null;
  card_masked_pan: string | null;
  client_ip: string | null;
  match_reason: 'name' | 'device' | 'ip' | null;
  matched_user_id: string | null;
  matched_email: string | null;
  matched_name: string | null;
  matched_card: string | null;
  created_at: string;
}

const REASON: Record<string, string> = {
  name: "те саме ім'я",
  device: 'той самий браузер',
  ip: 'та сама IP-адреса',
};

export function WelcomeBonusTab() {
  const [claims, setClaims] = useState<PendingClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.admin.getPendingWelcomeBonuses();
      setClaims(data.claims || []);
    } catch {
      toast.error('Не вдалося завантажити заявки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const review = async (userId: string, action: 'approve' | 'reject') => {
    setBusy(userId);
    try {
      await api.admin.reviewWelcomeBonus(userId, action);
      toast.success(action === 'approve' ? 'Бонус нараховано' : 'Заявку відхилено');
      setClaims((c) => c.filter((x) => x.user_id !== userId));
    } catch {
      toast.error('Не вдалося зберегти рішення');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="p-6 text-center text-gray-500">Завантаження…</div>;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="font-semibold text-sm text-gray-800">Бонуси на перевірці ({claims.length})</h3>
        <p className="text-xs text-gray-500 mt-1">
          Новий акаунт схожий на того, хто вже отримав бонус. Порівняйте акаунти й вирішіть.
        </p>
      </div>
      {claims.length === 0 ? (
        <div className="p-6 text-center text-sm text-gray-500">Заявок на перевірці немає.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Новий акаунт</th>
                <th className="px-4 py-2 text-left">Схожий на</th>
                <th className="px-4 py-2 text-left">Збіг</th>
                <th className="px-4 py-2 text-left">Дата</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.user_id} className="border-t border-gray-100 align-top">
                  <td className="px-4 py-2">
                    <div className="font-medium">{c.name || '—'}</div>
                    <div className="text-xs text-gray-500">{c.email}</div>
                    <div className="text-xs text-gray-500">{c.card_masked_pan} · {c.client_ip || 'IP невідома'}</div>
                  </td>
                  <td className="px-4 py-2">
                    <div className="font-medium">{c.matched_name || '—'}</div>
                    <div className="text-xs text-gray-500">{c.matched_email || c.matched_user_id}</div>
                    <div className="text-xs text-gray-500">{c.matched_card || 'картка невідома'}</div>
                  </td>
                  <td className="px-4 py-2">{c.match_reason ? REASON[c.match_reason] : '—'}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{new Date(c.created_at).toLocaleString('uk-UA')}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-right">
                    <button
                      disabled={busy === c.user_id}
                      onClick={() => review(c.user_id, 'approve')}
                      className="px-3 py-1.5 rounded bg-green-600 text-white text-xs font-medium disabled:opacity-50 mr-2">
                      Нарахувати
                    </button>
                    <button
                      disabled={busy === c.user_id}
                      onClick={() => review(c.user_id, 'reject')}
                      className="px-3 py-1.5 rounded bg-gray-200 text-gray-800 text-xs font-medium disabled:opacity-50">
                      Відхилити
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
