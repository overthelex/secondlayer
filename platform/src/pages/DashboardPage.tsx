import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Key, Wallet, Activity, ArrowRight, Zap } from 'lucide-react';
import { api } from '@/utils/api-client';
import { CodeBlock } from '@/components/CodeBlock';

interface DashboardData {
  keysCount: number;
  balance: number;
  firstKey: string | null;
  totalCalls: number;
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData>({ keysCount: 0, balance: 0, firstKey: null, totalCalls: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [keysRes, balanceRes, usageRes] = await Promise.all([
          api.get('/keys'),
          api.get('/keys/balance').catch(() => ({ data: { balance: 0 } })),
          api.get('/usage/summary?days=30').catch(() => ({ data: { total_calls: 0 } })),
        ]);

        const keys = keysRes.data.keys || [];
        setData({
          keysCount: keys.length,
          balance: Number(balanceRes.data.balance) || 0,
          firstKey: keys.length > 0 ? keys[0].key : null,
          totalCalls: usageRes.data.total_calls || 0,
        });
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return <div className="animate-pulse space-y-4">
      {[1, 2, 3].map(i => <div key={i} className="h-24 bg-white rounded-xl" />)}
    </div>;
  }

  const connectionCode = `claude mcp add --transport http secondlayer \\
  https://mcp.legal.org.ua/api/v2/mcp \\
  --header "Authorization: Bearer ${data.firstKey || 'YOUR_API_KEY'}"`;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-txt-primary">Dashboard</h1>
        <p className="text-sm text-txt-muted mt-1">
          Огляд вашого акаунта та швидкий старт
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          icon={Key}
          label="API Keys"
          value={String(data.keysCount)}
          linkTo="/keys"
          linkLabel="Керувати"
        />
        <StatCard
          icon={Wallet}
          label="Баланс"
          value={`$${data.balance.toFixed(2)}`}
          linkTo="/usage"
          linkLabel="Деталі"
        />
        <StatCard
          icon={Zap}
          label="Запити (30д)"
          value={data.totalCalls.toLocaleString()}
          linkTo="/usage"
          linkLabel="Аналітика"
        />
        <StatCard
          icon={Activity}
          label="Статус API"
          value="Active"
          color="text-green-600"
        />
      </div>

      <div className="bg-white rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-txt-primary mb-1">Quick Start</h2>
        <p className="text-sm text-txt-muted mb-4">
          Підключіть Claude Code до SecondLayer MCP сервера:
        </p>
        <CodeBlock code={connectionCode} title="Terminal" />
        <div className="mt-4 flex gap-3">
          <Link
            to="/docs/quickstart"
            className="text-sm text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1"
          >
            Повна інструкція <ArrowRight size={14} />
          </Link>
          <Link
            to="/docs/tools"
            className="text-sm text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1"
          >
            Перелік інструментів <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  linkTo,
  linkLabel,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  linkTo?: string;
  linkLabel?: string;
  color?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-border p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="p-2 bg-brand-50 rounded-lg text-brand-600">
          <Icon size={20} />
        </div>
        <span className="text-sm text-txt-muted">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${color || 'text-txt-primary'}`}>{value}</div>
      {linkTo && linkLabel && (
        <Link
          to={linkTo}
          className="text-xs text-brand-600 hover:text-brand-700 font-medium mt-2 inline-flex items-center gap-1"
        >
          {linkLabel} <ArrowRight size={12} />
        </Link>
      )}
    </div>
  );
}
