/**
 * Admin Monitoring Page
 * Dashboard showing status of all external data sources
 */

import React, { useEffect, useState } from 'react';
import { Activity, Database, RefreshCw, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { api } from '../utils/api-client';

interface BackendSource {
  id: string;
  name: string;
  service: string;
  metrics: Record<string, any>;
}

interface ExternalService {
  id: string;
  name: string;
  service: string;
  healthEndpoint: string;
  port: number;
  dataSources: { id: string; name: string; table?: string }[];
}

interface DataSourcesResponse {
  backendSources: BackendSource[];
  externalServices: ExternalService[];
  timestamp: string;
}

type HealthStatus = 'healthy' | 'degraded' | 'down' | 'loading';

function StatusBadge({ status }: { status: HealthStatus }) {
  const config = {
    healthy: { icon: CheckCircle, color: 'text-green-600 bg-green-50', label: 'OK' },
    degraded: { icon: AlertTriangle, color: 'text-yellow-600 bg-yellow-50', label: 'Degraded' },
    down: { icon: XCircle, color: 'text-red-600 bg-red-50', label: 'Down' },
    loading: { icon: RefreshCw, color: 'text-gray-400 bg-gray-50', label: '...' },
  };
  const { icon: Icon, color, label } = config[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${color}`}>
      <Icon size={12} className={status === 'loading' ? 'animate-spin' : ''} />
      {label}
    </span>
  );
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '0';
  return n.toLocaleString('uk-UA');
}

export function AdminMonitoringPage() {
  const [data, setData] = useState<DataSourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.admin.getDataSources();
      setData(response.data);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch data sources');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw size={32} className="text-claude-subtext animate-spin" />
          <p className="text-claude-subtext">Loading data sources...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <XCircle size={32} className="text-red-500" />
          <p className="text-red-600">{error}</p>
          <button onClick={fetchData} className="px-4 py-2 bg-claude-text text-white rounded-lg text-sm">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-claude-text font-sans">Data Sources Monitoring</h1>
          <p className="text-sm text-claude-subtext mt-1">
            Last updated: {data?.timestamp ? formatDate(data.timestamp) : 'N/A'}
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Backend Sources */}
      <section className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={18} className="text-claude-subtext" />
          <h2 className="text-lg font-semibold text-claude-text font-sans">Backend Sources</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.backendSources.map((source) => (
            <div key={source.id} className="bg-white rounded-xl border border-claude-border p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-claude-text text-sm">{source.name}</h3>
                <StatusBadge status={getBackendSourceStatus(source)} />
              </div>
              <div className="space-y-2 text-xs text-claude-subtext">
                {source.id === 'zakononline' && (
                  <>
                    <div className="flex justify-between">
                      <span>Calls (24h)</span>
                      <span className="font-medium text-claude-text">{formatNumber(source.metrics.calls_24h)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Errors (24h)</span>
                      <span className={`font-medium ${source.metrics.errors_24h > 0 ? 'text-red-600' : 'text-claude-text'}`}>
                        {formatNumber(source.metrics.errors_24h)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Last call</span>
                      <span className="font-medium text-claude-text">{formatDate(source.metrics.last_call)}</span>
                    </div>
                  </>
                )}
                {source.id === 'legislation' && (
                  <>
                    <div className="flex justify-between">
                      <span>Codes</span>
                      <span className="font-medium text-claude-text">{formatNumber(source.metrics.codes_count)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Articles</span>
                      <span className="font-medium text-claude-text">{formatNumber(source.metrics.articles_count)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Latest update</span>
                      <span className="font-medium text-claude-text">{formatDate(source.metrics.newest_update)}</span>
                    </div>
                  </>
                )}
                {source.id === 'zo_dictionaries' && (
                  <>
                    <div className="flex justify-between">
                      <span>Loaded domains</span>
                      <span className="font-medium text-claude-text">{formatNumber(source.metrics.loaded_domains)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Total entries</span>
                      <span className="font-medium text-claude-text">{formatNumber(source.metrics.total_entries)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Last update</span>
                      <span className="font-medium text-claude-text">{formatDate(source.metrics.last_update)}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* External Services */}
      {data?.externalServices.map((service) => (
        <section key={service.id} className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <Database size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">{service.name}</h2>
            <span className="text-xs text-claude-subtext bg-claude-subtext/10 px-2 py-0.5 rounded-full">
              port {service.port}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {service.dataSources.map((ds) => (
              <div key={ds.id} className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
                <h3 className="font-semibold text-claude-text text-sm mb-1">{ds.name}</h3>
                {ds.table && (
                  <p className="text-xs text-claude-subtext font-mono">{ds.table}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function getBackendSourceStatus(source: BackendSource): HealthStatus {
  if (source.id === 'zakononline') {
    if (source.metrics.errors_24h > 10) return 'degraded';
    if (!source.metrics.last_call) return 'down';
    return 'healthy';
  }
  if (source.id === 'legislation') {
    if (source.metrics.codes_count === 0) return 'down';
    return 'healthy';
  }
  if (source.id === 'zo_dictionaries') {
    if (source.metrics.loaded_domains === 0) return 'down';
    return 'healthy';
  }
  return 'healthy';
}
