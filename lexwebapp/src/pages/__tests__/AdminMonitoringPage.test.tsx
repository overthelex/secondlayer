/**
 * AdminMonitoringPage Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Mock api-client
const mockGetDataSources = vi.fn();

vi.mock('../../utils/api-client', () => ({
  default: {},
  api: {
    admin: {
      getDataSources: () => mockGetDataSources(),
    },
  },
}));

import { AdminMonitoringPage } from '../AdminMonitoringPage';

const mockDataSources = {
  backendSources: [
    {
      id: 'zakononline',
      name: 'ZakonOnline',
      service: 'backend',
      metrics: { calls_24h: 1250, errors_24h: 3, last_call: '2026-02-15T14:30:00Z' },
    },
    {
      id: 'legislation',
      name: 'Legislation',
      service: 'backend',
      metrics: { codes_count: 12, articles_count: 5191, newest_update: '2026-02-10T00:00:00Z' },
    },
    {
      id: 'zo_dictionaries',
      name: 'ZO Dictionaries',
      service: 'backend',
      metrics: { loaded_domains: 8, total_entries: 4500, last_update: '2026-02-12T00:00:00Z' },
    },
  ],
  externalServices: [
    {
      id: 'rada',
      name: 'Verkhovna Rada',
      service: 'mcp_rada',
      healthEndpoint: '/health',
      port: 3001,
      dataSources: [
        { id: 'deputies', name: 'Deputies', table: 'deputies' },
        { id: 'bills', name: 'Bills', table: 'bills' },
      ],
    },
  ],
  timestamp: '2026-02-15T15:00:00Z',
};

describe('AdminMonitoringPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading spinner initially', () => {
    mockGetDataSources.mockReturnValue(new Promise(() => {}));
    render(<AdminMonitoringPage />);
    expect(screen.getByText('Loading data sources...')).toBeInTheDocument();
  });

  it('renders page header and backend sources after data loads', async () => {
    mockGetDataSources.mockResolvedValue({ data: mockDataSources });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('Data Sources Monitoring')).toBeInTheDocument();
    });

    expect(screen.getByText('Backend Sources')).toBeInTheDocument();
    expect(screen.getByText('ZakonOnline')).toBeInTheDocument();
    expect(screen.getByText('Legislation')).toBeInTheDocument();
    expect(screen.getByText('ZO Dictionaries')).toBeInTheDocument();
  });

  it('renders ZakonOnline metrics', async () => {
    mockGetDataSources.mockResolvedValue({ data: mockDataSources });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('ZakonOnline')).toBeInTheDocument();
    });

    expect(screen.getByText('Calls (24h)')).toBeInTheDocument();
    expect(screen.getByText('Errors (24h)')).toBeInTheDocument();
    expect(screen.getByText('Last call')).toBeInTheDocument();
  });

  it('renders Legislation metrics', async () => {
    mockGetDataSources.mockResolvedValue({ data: mockDataSources });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('Legislation')).toBeInTheDocument();
    });

    expect(screen.getByText('Codes')).toBeInTheDocument();
    expect(screen.getByText('Articles')).toBeInTheDocument();
    expect(screen.getByText('Latest update')).toBeInTheDocument();
  });

  it('renders ZO Dictionaries metrics', async () => {
    mockGetDataSources.mockResolvedValue({ data: mockDataSources });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('ZO Dictionaries')).toBeInTheDocument();
    });

    expect(screen.getByText('Loaded domains')).toBeInTheDocument();
    expect(screen.getByText('Total entries')).toBeInTheDocument();
  });

  it('renders external services section', async () => {
    mockGetDataSources.mockResolvedValue({ data: mockDataSources });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('Verkhovna Rada')).toBeInTheDocument();
    });

    expect(screen.getByText('port 3001')).toBeInTheDocument();
    expect(screen.getByText('Deputies')).toBeInTheDocument();
    expect(screen.getByText('Bills')).toBeInTheDocument();
  });

  it('shows OK status for healthy ZakonOnline', async () => {
    mockGetDataSources.mockResolvedValue({ data: mockDataSources });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('ZakonOnline')).toBeInTheDocument();
    });

    // ZakonOnline has 3 errors (< 10) and has last_call → healthy → "OK"
    const okBadges = screen.getAllByText('OK');
    expect(okBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('shows Degraded status when errors > 10', async () => {
    const degradedData = {
      ...mockDataSources,
      backendSources: [
        {
          id: 'zakononline',
          name: 'ZakonOnline',
          service: 'backend',
          metrics: { calls_24h: 100, errors_24h: 15, last_call: '2026-02-15T14:30:00Z' },
        },
      ],
      externalServices: [],
    };
    mockGetDataSources.mockResolvedValue({ data: degradedData });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('Degraded')).toBeInTheDocument();
    });
  });

  it('shows Down status when legislation codes_count is 0', async () => {
    const downData = {
      ...mockDataSources,
      backendSources: [
        {
          id: 'legislation',
          name: 'Legislation',
          service: 'backend',
          metrics: { codes_count: 0, articles_count: 0, newest_update: null },
        },
      ],
      externalServices: [],
    };
    mockGetDataSources.mockResolvedValue({ data: downData });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('Down')).toBeInTheDocument();
    });
  });

  it('shows Down status when zo_dictionaries loaded_domains is 0', async () => {
    const downData = {
      ...mockDataSources,
      backendSources: [
        {
          id: 'zo_dictionaries',
          name: 'ZO Dictionaries',
          service: 'backend',
          metrics: { loaded_domains: 0, total_entries: 0, last_update: null },
        },
      ],
      externalServices: [],
    };
    mockGetDataSources.mockResolvedValue({ data: downData });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('Down')).toBeInTheDocument();
    });
  });

  it('shows error state with retry button on API failure', async () => {
    mockGetDataSources.mockRejectedValue({ message: 'Timeout' });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('Timeout')).toBeInTheDocument();
    });
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('retry button re-fetches data', async () => {
    mockGetDataSources.mockRejectedValueOnce({ message: 'Fail' });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    mockGetDataSources.mockResolvedValue({ data: mockDataSources });
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(screen.getByText('Data Sources Monitoring')).toBeInTheDocument();
    });
  });

  it('refresh button re-fetches data', async () => {
    mockGetDataSources.mockResolvedValue({ data: mockDataSources });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Refresh'));
    expect(mockGetDataSources).toHaveBeenCalledTimes(2);
  });

  it('shows server error message from response data', async () => {
    mockGetDataSources.mockRejectedValue({
      response: { data: { error: 'Admin access required' } },
    });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('Admin access required')).toBeInTheDocument();
    });
  });

  it('renders table names in external service data sources', async () => {
    mockGetDataSources.mockResolvedValue({ data: mockDataSources });
    render(<AdminMonitoringPage />);

    await waitFor(() => {
      expect(screen.getByText('deputies')).toBeInTheDocument();
    });
    expect(screen.getByText('bills')).toBeInTheDocument();
  });
});
