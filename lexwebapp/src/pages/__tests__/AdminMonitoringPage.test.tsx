/**
 * AdminMonitoringPage Tests
 * Tests for the current multi-section monitoring dashboard
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Mock API
const mockGetDataSources = vi.fn();
const mockGetRecentCourtDocs = vi.fn();
const mockGetBackfillStatus = vi.fn();
const mockGetCourtScraperStatus = vi.fn();
const mockGetImportSamples = vi.fn();

vi.mock('../../utils/api-client', () => ({
  default: {},
  api: {
    admin: {
      getDataSources: (...args: any[]) => mockGetDataSources(...args),
      getRecentCourtDocs: (...args: any[]) => mockGetRecentCourtDocs(...args),
      runDocumentCompletenessCheck: vi.fn(),
      startBackfillFulltext: vi.fn(),
      getBackfillStatus: (...args: any[]) => mockGetBackfillStatus(...args),
      stopBackfill: vi.fn(),
      startCourtScraper: vi.fn(),
      getCourtScraperStatus: (...args: any[]) => mockGetCourtScraperStatus(...args),
      stopCourtScraper: vi.fn(),
      getImportSamples: (...args: any[]) => mockGetImportSamples(...args),
    },
    documents: {
      getById: vi.fn(),
    },
  },
}));

import { AdminMonitoringPage } from '../AdminMonitoringPage';

const mockBackendData = {
  tables: [
    {
      id: 'documents',
      name: 'Документи ZakonOnline',
      rows: 15240,
      source: 'ZakonOnline — Документи',
      sourceUrl: 'https://zakononline.com.ua',
      updateFrequency: 'Щоденно',
      lastUpdate: '2026-02-20T10:00:00Z',
      lastBatchCount: 120,
    },
    {
      id: 'legislation',
      name: 'Законодавство',
      rows: 5191,
      source: 'Верховна Рада — Законодавство',
      sourceUrl: 'https://zakon.rada.gov.ua',
      updateFrequency: 'Щомісячно',
      lastUpdate: '2026-02-10T00:00:00Z',
      lastBatchCount: 0,
    },
  ],
  dbSizeMb: 842,
};

const mockRadaData = {
  tables: {
    deputies: {
      rows: 450,
      source: 'Верховна Рада — Депутати',
      sourceUrl: 'https://data.rada.gov.ua',
      updateFrequency: 'Щотижнево',
      lastUpdate: '2026-02-18T00:00:00Z',
    },
  },
  dbSizeMb: 120,
};

const mockCourtDocsData = {
  total_court_docs: 15240,
  recent_court_docs: 350,
  days: 30,
  categories: [
    {
      code: '1',
      name: 'Цивільне судочинство',
      total: 8000,
      recent: 150,
      earliest_date: '2015-01-01',
      latest_date: '2026-02-19',
      last_loaded_at: '2026-02-20T09:00:00Z',
      documents: [],
    },
  ],
};

describe('AdminMonitoringPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDataSources.mockImplementation((section?: string) => {
      if (section === 'backend') {
        return Promise.resolve({ data: mockBackendData });
      }
      if (section === 'rada') {
        return Promise.resolve({ data: mockRadaData });
      }
      return Promise.resolve({ data: { tables: {}, dbSizeMb: 0 } });
    });
    mockGetRecentCourtDocs.mockResolvedValue({ data: mockCourtDocsData });
    mockGetBackfillStatus.mockResolvedValue({ data: { active: false, job: null } });
    mockGetCourtScraperStatus.mockResolvedValue({ data: { active: false, job: null } });
    mockGetImportSamples.mockResolvedValue({
      data: { hours: 24, samples: [], summary: { court_decisions: 0, legislation: 0, embeddings: 0, user_uploads: 0 }, timestamp: new Date().toISOString() },
    });
  });

  it('shows page header after load', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('Моніторинг джерел даних')).toBeInTheDocument();
    });
  });

  it('shows refresh button', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('Оновити')).toBeInTheDocument();
    });
  });

  it('shows backend section header after data loads', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('Backend (mcp_backend)')).toBeInTheDocument();
    });
  });

  it('renders backend table rows', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('documents')).toBeInTheDocument();
    });
    expect(screen.getByText('legislation')).toBeInTheDocument();
  });

  it('shows court docs section', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('Судові рішення за видами права')).toBeInTheDocument();
    });
  });

  it('shows court doc categories', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('Цивільне судочинство')).toBeInTheDocument();
    });
  });

  it('shows document completeness section', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('Перевірка повноти документів')).toBeInTheDocument();
    });
  });

  it('shows court scraper section', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('Докачати документи з реєстру')).toBeInTheDocument();
    });
  });

  it('shows RADA section', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('RADA Server (mcp_rada)')).toBeInTheDocument();
    });
  });

  it('shows OpenReyestr section', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('OpenReyestr Server (mcp_openreyestr)')).toBeInTheDocument();
    });
  });

  it('renders RADA table data', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('deputies')).toBeInTheDocument();
    });
  });

  it('shows error state with retry for backend section on API failure', async () => {
    mockGetDataSources.mockImplementation((section?: string) => {
      if (section === 'backend') return Promise.reject({ message: 'Network error', response: { data: { error: 'Network error' } } });
      return Promise.resolve({ data: { tables: {}, dbSizeMb: 0 } });
    });
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
    // Retry button appears
    expect(screen.getAllByText('Повторити').length).toBeGreaterThanOrEqual(1);
  });

  it('shows RADA offline badge when service returns error', async () => {
    mockGetDataSources.mockImplementation((section?: string) => {
      if (section === 'backend') return Promise.resolve({ data: mockBackendData });
      if (section === 'rada') return Promise.resolve({ data: { tables: {}, dbSizeMb: 0, error: 'Service unavailable' } });
      return Promise.resolve({ data: { tables: {}, dbSizeMb: 0 } });
    });
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('RADA Server (mcp_rada)')).toBeInTheDocument();
    });
    // Should show "Недоступний" for RADA
    expect(screen.getAllByText('Недоступний').length).toBeGreaterThanOrEqual(1);
  });

  it('shows summary cards with totals', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getByText('Всього записів')).toBeInTheDocument();
    });
    expect(screen.getByText('Backend DB')).toBeInTheDocument();
    expect(screen.getByText('RADA DB')).toBeInTheDocument();
    expect(screen.getByText('OpenReyestr DB')).toBeInTheDocument();
  });

  it('refresh button re-fetches all data', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getAllByText('Оновити').length).toBeGreaterThanOrEqual(1);
    });
    // Initial load calls getDataSources for backend/rada/openreyestr
    const initialCalls = mockGetDataSources.mock.calls.length;
    // Click the first "Оновити" (header refresh button)
    fireEvent.click(screen.getAllByText('Оновити')[0]);
    await waitFor(() => {
      expect(mockGetDataSources.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it('shows "Завантаження..." section loaders while fetching', () => {
    // Don't resolve promises — keep loading
    mockGetDataSources.mockReturnValue(new Promise(() => {}));
    mockGetRecentCourtDocs.mockReturnValue(new Promise(() => {}));
    render(<AdminMonitoringPage />);
    const loaders = screen.getAllByText('Завантаження...');
    expect(loaders.length).toBeGreaterThan(0);
  });

  it('shows dbSizeMb in backend section header', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/842 MB/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('calls getDataSources for all three services on mount', async () => {
    render(<AdminMonitoringPage />);
    await waitFor(() => {
      expect(mockGetDataSources).toHaveBeenCalledWith('backend');
      expect(mockGetDataSources).toHaveBeenCalledWith('rada');
      expect(mockGetDataSources).toHaveBeenCalledWith('openreyestr');
    });
  });
});
