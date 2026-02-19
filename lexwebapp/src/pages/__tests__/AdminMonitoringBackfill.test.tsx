/**
 * Tests for Document Completeness & Backfill UI in AdminMonitoringPage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

// Mock timers for polling
vi.useFakeTimers({ shouldAdvanceTime: true });

// Mock API
const mockRunCompletenessCheck = vi.fn();
const mockStartBackfill = vi.fn();
const mockGetBackfillStatus = vi.fn();
const mockStopBackfill = vi.fn();
const mockGetDataSources = vi.fn();
const mockGetRecentCourtDocs = vi.fn();

vi.mock('../../utils/api-client', () => ({
  default: {},
  api: {
    admin: {
      getDataSources: (...args: any[]) => mockGetDataSources(...args),
      getRecentCourtDocs: (...args: any[]) => mockGetRecentCourtDocs(...args),
      runDocumentCompletenessCheck: () => mockRunCompletenessCheck(),
      startBackfillFulltext: (params: any) => mockStartBackfill(params),
      getBackfillStatus: (jobId?: string) => mockGetBackfillStatus(jobId),
      stopBackfill: (jobId: string) => mockStopBackfill(jobId),
    },
  },
}));

import { AdminMonitoringPage } from '../AdminMonitoringPage';

// --- Mock data ---

const mockCompletenessResult = {
  checked_at: '2026-02-19T10:00:00Z',
  runs_today: 1,
  max_runs_per_day: 5,
  summary: {
    total_documents: 1000,
    with_plaintext: 800,
    with_html: 750,
    with_both: 700,
    missing_both: 150,
    completeness_pct: 70,
  },
  by_justice_kind: [
    {
      justice_kind: 'Цивільне',
      justice_kind_code: '1',
      total: 600,
      has_plaintext: 500,
      has_html: 480,
      has_both: 450,
      missing_both: 80,
      completeness_pct: 75,
    },
    {
      justice_kind: 'Кримінальне',
      justice_kind_code: '5',
      total: 400,
      has_plaintext: 300,
      has_html: 270,
      has_both: 250,
      missing_both: 70,
      completeness_pct: 62.5,
    },
  ],
};

const mockBackfillJobRunning = {
  active: true,
  job: {
    job_id: 'backfill-123',
    status: 'running',
    justice_kind_code: null,
    total: 150,
    processed: 45,
    scraped: 40,
    errors: 5,
    error_details: ['111: Connection timeout'],
    started_at: '2026-02-19T10:05:00Z',
  },
};

const mockBackfillJobCompleted = {
  active: false,
  job: {
    job_id: 'backfill-123',
    status: 'completed',
    justice_kind_code: null,
    total: 150,
    processed: 150,
    scraped: 140,
    errors: 10,
    error_details: ['111: Connection timeout', '222: empty text'],
    started_at: '2026-02-19T10:05:00Z',
    completed_at: '2026-02-19T10:15:00Z',
  },
};

describe('Document Completeness & Backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: data sources load, no active backfill
    // Backend expects { tables: TableInfo[], dbSizeMb }; rada/openreyestr expect { tables: Record, dbSizeMb }
    mockGetDataSources.mockImplementation((section?: string) => {
      if (section === 'backend') {
        return Promise.resolve({
          data: {
            tables: [
              { id: 'documents', name: 'Документи', rows: 1000, source: 'ZO', sourceUrl: '', updateFrequency: 'daily', lastUpdate: null },
            ],
            dbSizeMb: 100,
          },
        });
      }
      // rada / openreyestr
      return Promise.resolve({
        data: { tables: {}, dbSizeMb: 50 },
      });
    });
    mockGetRecentCourtDocs.mockResolvedValue({
      data: { total_court_docs: 1000, recent_court_docs: 50, days: 30, categories: [] },
    });
    mockGetBackfillStatus.mockResolvedValue({
      data: { active: false, job: null },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('Completeness Check', () => {
    it('shows completeness check button', async () => {
      render(<AdminMonitoringPage />);
      await waitFor(() => {
        expect(screen.getByText('Запустити перевірку')).toBeInTheDocument();
      });
    });

    it('runs completeness check and shows results', async () => {
      mockRunCompletenessCheck.mockResolvedValue({ data: mockCompletenessResult });
      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Запустити перевірку')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Запустити перевірку'));
      });

      await waitFor(() => {
        // Summary card shows completeness %
        expect(screen.getByText('Повнота (обидва поля)')).toBeInTheDocument();
      });

      // Table rows
      expect(screen.getByText('Цивільне')).toBeInTheDocument();
      expect(screen.getByText('Кримінальне')).toBeInTheDocument();
      // Summary card labels
      expect(screen.getByText('Всього документів')).toBeInTheDocument();
      expect(screen.getByText('Без обох полів')).toBeInTheDocument();
    });

    it('shows "Докачати всі" button when there are missing documents', async () => {
      mockRunCompletenessCheck.mockResolvedValue({ data: mockCompletenessResult });
      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Запустити перевірку')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Запустити перевірку'));
      });

      await waitFor(() => {
        expect(screen.getByText(/Докачати всі/)).toBeInTheDocument();
      });
    });

    it('shows per-row "Докачати" buttons for rows with missing docs', async () => {
      mockRunCompletenessCheck.mockResolvedValue({ data: mockCompletenessResult });
      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Запустити перевірку')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Запустити перевірку'));
      });

      await waitFor(() => {
        const backfillButtons = screen.getAllByText('Докачати');
        // 2 justice kinds with missing docs = 2 buttons
        expect(backfillButtons.length).toBe(2);
      });
    });

    it('does not show backfill button when all documents are complete', async () => {
      const completeResult = {
        ...mockCompletenessResult,
        summary: { ...mockCompletenessResult.summary, missing_both: 0, completeness_pct: 100 },
        by_justice_kind: mockCompletenessResult.by_justice_kind.map(r => ({
          ...r, missing_both: 0, completeness_pct: 100,
        })),
      };
      mockRunCompletenessCheck.mockResolvedValue({ data: completeResult });
      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Запустити перевірку')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Запустити перевірку'));
      });

      await waitFor(() => {
        // Table rendered with both justice kinds
        expect(screen.getByText('Цивільне')).toBeInTheDocument();
      });

      expect(screen.queryByText(/Докачати всі/)).not.toBeInTheDocument();
      expect(screen.queryByText('Докачати')).not.toBeInTheDocument();
    });

    it('shows limit reached after max runs', async () => {
      mockRunCompletenessCheck.mockResolvedValue({
        data: { ...mockCompletenessResult, runs_today: 5, max_runs_per_day: 5 },
      });
      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Запустити перевірку')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Запустити перевірку'));
      });

      await waitFor(() => {
        expect(screen.getByText('Ліміт вичерпано')).toBeInTheDocument();
      });
    });

    it('handles 429 error for completeness check', async () => {
      mockRunCompletenessCheck.mockRejectedValue({
        response: { status: 429, data: { error: 'Ліміт вичерпано: 5/5 перевірок сьогодні' } },
      });
      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Запустити перевірку')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Запустити перевірку'));
      });

      await waitFor(() => {
        expect(screen.getByText('Ліміт вичерпано')).toBeInTheDocument();
      });
    });
  });

  describe('Backfill - Start', () => {
    it('starts backfill for all when "Докачати всі" is clicked', async () => {
      mockRunCompletenessCheck.mockResolvedValue({ data: mockCompletenessResult });
      mockStartBackfill.mockResolvedValue({
        data: { job_id: 'backfill-456', status: 'queued', total: 150 },
      });
      // Return running status on subsequent polls
      mockGetBackfillStatus
        .mockResolvedValueOnce({ data: { active: false, job: null } }) // initial mount
        .mockResolvedValue({ data: mockBackfillJobRunning }); // subsequent polls

      render(<AdminMonitoringPage />);

      // Run completeness check first
      await waitFor(() => {
        expect(screen.getByText('Запустити перевірку')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Запустити перевірку'));
      });

      await waitFor(() => {
        expect(screen.getByText(/Докачати всі/)).toBeInTheDocument();
      });

      // Click backfill all
      await act(async () => {
        fireEvent.click(screen.getByText(/Докачати всі/));
      });

      expect(mockStartBackfill).toHaveBeenCalledWith({
        justice_kind_code: 'all',
        limit: 200,
      });
    });

    it('starts backfill for specific justice kind', async () => {
      mockRunCompletenessCheck.mockResolvedValue({ data: mockCompletenessResult });
      mockStartBackfill.mockResolvedValue({
        data: { job_id: 'backfill-789', status: 'queued', total: 80 },
      });
      mockGetBackfillStatus
        .mockResolvedValueOnce({ data: { active: false, job: null } })
        .mockResolvedValue({ data: mockBackfillJobRunning });

      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Запустити перевірку')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Запустити перевірку'));
      });

      await waitFor(() => {
        const buttons = screen.getAllByText('Докачати');
        expect(buttons.length).toBe(2);
      });

      // Click first per-row button (Цивільне, code '1')
      const buttons = screen.getAllByText('Докачати');
      await act(async () => {
        fireEvent.click(buttons[0]);
      });

      expect(mockStartBackfill).toHaveBeenCalledWith({
        justice_kind_code: '1',
        limit: 200,
      });
    });

    it('handles 409 conflict (already running) by fetching status', async () => {
      mockRunCompletenessCheck.mockResolvedValue({ data: mockCompletenessResult });
      mockStartBackfill.mockRejectedValue({
        response: { status: 409, data: { error: 'Backfill вже виконується', job_id: 'backfill-existing' } },
      });
      mockGetBackfillStatus
        .mockResolvedValueOnce({ data: { active: false, job: null } }) // initial mount
        .mockResolvedValue({ data: mockBackfillJobRunning }); // after 409

      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Запустити перевірку')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Запустити перевірку'));
      });

      await waitFor(() => {
        expect(screen.getByText(/Докачати всі/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText(/Докачати всі/));
      });

      // Should have tried to fetch existing job status
      await waitFor(() => {
        expect(mockGetBackfillStatus).toHaveBeenCalledTimes(2); // mount + after 409
      });
    });
  });

  describe('Backfill - Progress', () => {
    it('shows progress bar when backfill is active on mount', async () => {
      mockGetBackfillStatus.mockResolvedValue({ data: mockBackfillJobRunning });

      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Докачування...')).toBeInTheDocument();
      });

      expect(screen.getByText('45/150 оброблено')).toBeInTheDocument();
      expect(screen.getByText('40 докачано')).toBeInTheDocument();
      expect(screen.getByText('5 помилок')).toBeInTheDocument();
      expect(screen.getByText('30%')).toBeInTheDocument();
    });

    it('shows stop button during active backfill', async () => {
      mockGetBackfillStatus.mockResolvedValue({ data: mockBackfillJobRunning });

      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Зупинити')).toBeInTheDocument();
      });
    });

    it('shows completed state with "Приховати" button', async () => {
      mockGetBackfillStatus.mockResolvedValue({ data: mockBackfillJobCompleted });

      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Завершено')).toBeInTheDocument();
      });

      expect(screen.getByText('150/150 оброблено')).toBeInTheDocument();
      expect(screen.getByText('140 докачано')).toBeInTheDocument();
      expect(screen.getByText('10 помилок')).toBeInTheDocument();
      expect(screen.getByText('Приховати')).toBeInTheDocument();
    });

    it('hides progress when "Приховати" is clicked', async () => {
      mockGetBackfillStatus.mockResolvedValue({ data: mockBackfillJobCompleted });

      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Завершено')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Приховати'));
      });

      expect(screen.queryByText('Завершено')).not.toBeInTheDocument();
    });

    it('hides backfill buttons while job is active', async () => {
      mockGetBackfillStatus.mockResolvedValue({ data: mockBackfillJobRunning });
      mockRunCompletenessCheck.mockResolvedValue({ data: mockCompletenessResult });

      render(<AdminMonitoringPage />);

      // Wait for active backfill to render
      await waitFor(() => {
        expect(screen.getByText('Докачування...')).toBeInTheDocument();
      });

      // Run completeness check
      await act(async () => {
        fireEvent.click(screen.getByText('Запустити перевірку'));
      });

      await waitFor(() => {
        expect(screen.getByText('Цивільне')).toBeInTheDocument();
      });

      // "Докачати всі" and per-row buttons should NOT appear while active
      expect(screen.queryByText(/Докачати всі/)).not.toBeInTheDocument();
      expect(screen.queryByText('Докачати')).not.toBeInTheDocument();
    });
  });

  describe('Backfill - Stop', () => {
    it('calls stop API when stop button is clicked', async () => {
      mockGetBackfillStatus.mockResolvedValue({ data: mockBackfillJobRunning });
      mockStopBackfill.mockResolvedValue({ data: { message: 'Stop requested' } });

      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Зупинити')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Зупинити'));
      });

      expect(mockStopBackfill).toHaveBeenCalledWith('backfill-123');
    });
  });

  describe('Backfill - Error Details', () => {
    it('shows error details expandable after completion', async () => {
      mockGetBackfillStatus.mockResolvedValue({ data: mockBackfillJobCompleted });

      render(<AdminMonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText('Завершено')).toBeInTheDocument();
      });

      // Error details should be in a <details> element
      const details = screen.getByText(/Деталі помилок/);
      expect(details).toBeInTheDocument();

      // Expand
      await act(async () => {
        fireEvent.click(details);
      });

      expect(screen.getByText('111: Connection timeout')).toBeInTheDocument();
      expect(screen.getByText('222: empty text')).toBeInTheDocument();
    });
  });
});
