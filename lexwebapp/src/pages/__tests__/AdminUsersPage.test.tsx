/**
 * AdminUsersPage Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock react-hot-toast
vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock api-client
const mockGetUsers = vi.fn();
const mockGetUser = vi.fn();
const mockUpdateUserTier = vi.fn();
const mockAdjustBalance = vi.fn();
const mockUpdateLimits = vi.fn();

vi.mock('../../utils/api-client', () => ({
  default: {},
  api: {
    admin: {
      getUsers: (params?: any) => mockGetUsers(params),
      getUser: (id: string) => mockGetUser(id),
      updateUserTier: (id: string, tier: string) => mockUpdateUserTier(id, tier),
      adjustBalance: (id: string, amount: number, reason: string) => mockAdjustBalance(id, amount, reason),
      updateLimits: (id: string, limits: any) => mockUpdateLimits(id, limits),
    },
  },
}));

import { AdminUsersPage } from '../AdminUsersPage';

const mockUsersData = {
  users: [
    {
      id: 'user-1',
      email: 'alice@example.com',
      name: 'Alice Smith',
      created_at: '2026-01-01T00:00:00Z',
      balance_usd: 50.25,
      pricing_tier: 'business',
      total_requests: 1200,
      last_request_at: '2026-02-15T10:00:00Z',
    },
    {
      id: 'user-2',
      email: 'bob@example.com',
      name: null,
      created_at: '2026-01-15T00:00:00Z',
      balance_usd: 0,
      pricing_tier: 'free',
      total_requests: 5,
      last_request_at: null,
    },
  ],
  pagination: { limit: 20, offset: 0, total: 2 },
};

const mockUserDetail = {
  user: { id: 'user-1', email: 'alice@example.com' },
  transactions: [
    { type: 'charge', amount_usd: 0.015, created_at: '2026-02-15T09:00:00Z' },
  ],
  stats: {
    total_requests: 1200,
    total_spent: 18.0,
    avg_cost: 0.015,
    last_request: '2026-02-15T10:00:00Z',
  },
};

/** Helper: get action buttons for the first user row */
function getActionButtons() {
  const buttons = screen.getAllByRole('button');
  const tierBtn = buttons.find((b) => b.textContent === 'Tier' && b.tagName === 'BUTTON');
  const balanceBtn = buttons.find((b) => b.textContent === 'Balance' && b.tagName === 'BUTTON');
  const limitsBtn = buttons.find((b) => b.textContent === 'Limits' && b.tagName === 'BUTTON');
  return { tierBtn: tierBtn!, balanceBtn: balanceBtn!, limitsBtn: limitsBtn! };
}

describe('AdminUsersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetUsers.mockReturnValue(new Promise(() => {}));
    render(<AdminUsersPage />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders user list after data loads', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    expect(screen.getByText('business')).toBeInTheDocument();
    expect(screen.getByText('free')).toBeInTheDocument();
    expect(screen.getByText('$50.25')).toBeInTheDocument();
  });

  it('shows "No users found" when list is empty', async () => {
    mockGetUsers.mockResolvedValue({
      data: { users: [], pagination: { limit: 20, offset: 0, total: 0 } },
    });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('No users found')).toBeInTheDocument();
    });
  });

  it('shows error state with retry button', async () => {
    mockGetUsers.mockRejectedValue({ message: 'Server down' });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('Server down')).toBeInTheDocument();
    });
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('displays total users count in header', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('2 total users')).toBeInTheDocument();
    });
  });

  it('search button triggers fetch with search param', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search by email or name...');
    await userEvent.type(searchInput, 'alice');

    const searchButton = screen.getByText('Search');
    await userEvent.click(searchButton);

    await waitFor(() => {
      expect(mockGetUsers).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'alice' })
      );
    });
  });

  it('Enter key in search input triggers search', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search by email or name...');
    await userEvent.type(searchInput, 'bob{Enter}');

    await waitFor(() => {
      expect(mockGetUsers).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'bob' })
      );
    });
  });

  it('tier filter dropdown triggers fetch with tier param', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const tierSelect = screen.getByDisplayValue('All Tiers');
    await userEvent.selectOptions(tierSelect, 'business');

    await waitFor(() => {
      expect(mockGetUsers).toHaveBeenCalledWith(
        expect.objectContaining({ tier: 'business' })
      );
    });
  });

  it('clicking a user row expands detail panel', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    mockGetUser.mockResolvedValue({ data: mockUserDetail });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const userRow = screen.getByText('alice@example.com');
    fireEvent.click(userRow);

    await waitFor(() => {
      expect(screen.getByText('Total Spent')).toBeInTheDocument();
    });

    expect(screen.getByText('$18.00')).toBeInTheDocument();
    expect(screen.getByText('Avg Cost/Request')).toBeInTheDocument();
  });

  it('clicking same user row collapses detail panel', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    mockGetUser.mockResolvedValue({ data: mockUserDetail });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const userRow = screen.getByText('alice@example.com');
    fireEvent.click(userRow);

    await waitFor(() => {
      expect(screen.getByText('Total Spent')).toBeInTheDocument();
    });

    // Click again to collapse
    fireEvent.click(userRow);
    expect(screen.queryByText('Total Spent')).not.toBeInTheDocument();
  });

  it('Tier action button opens tier modal', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const { tierBtn } = getActionButtons();
    fireEvent.click(tierBtn);

    expect(screen.getByText('Change Pricing Tier')).toBeInTheDocument();
    expect(screen.getByText('Update Tier')).toBeInTheDocument();
  });

  it('Balance action button opens balance modal', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const { balanceBtn } = getActionButtons();
    fireEvent.click(balanceBtn);

    expect(screen.getByPlaceholderText('Amount (negative to deduct)')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Reason')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adjust Balance' })).toBeInTheDocument();
  });

  it('Limits action button opens limits modal', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const { limitsBtn } = getActionButtons();
    fireEvent.click(limitsBtn);

    expect(screen.getByRole('button', { name: 'Update Limits' })).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('Leave empty to keep current')).toHaveLength(2);
  });

  it('successfully updates tier via modal', async () => {
    const toast = await import('react-hot-toast');
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    mockUpdateUserTier.mockResolvedValue({});
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const { tierBtn } = getActionButtons();
    fireEvent.click(tierBtn);

    // Find the select inside the modal
    const modal = screen.getByText('Change Pricing Tier').closest('div')!.parentElement!;
    const select = within(modal).getByRole('combobox');
    await userEvent.selectOptions(select, 'enterprise');

    fireEvent.click(screen.getByText('Update Tier'));

    await waitFor(() => {
      expect(mockUpdateUserTier).toHaveBeenCalledWith('user-1', 'enterprise');
      expect(toast.default.success).toHaveBeenCalledWith('Tier updated');
    });
  });

  it('shows error toast when tier update fails', async () => {
    const toast = await import('react-hot-toast');
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    mockUpdateUserTier.mockRejectedValue(new Error('fail'));
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const { tierBtn } = getActionButtons();
    fireEvent.click(tierBtn);
    fireEvent.click(screen.getByText('Update Tier'));

    await waitFor(() => {
      expect(toast.default.error).toHaveBeenCalledWith('Failed to update tier');
    });
  });

  it('shows error toast for invalid balance input', async () => {
    const toast = await import('react-hot-toast');
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const { balanceBtn } = getActionButtons();
    fireEvent.click(balanceBtn);

    // Click adjust without filling in amount/reason
    fireEvent.click(screen.getByRole('button', { name: 'Adjust Balance' }));

    await waitFor(() => {
      expect(toast.default.error).toHaveBeenCalledWith('Enter valid amount and reason');
    });
  });

  it('successfully adjusts balance via modal', async () => {
    const toast = await import('react-hot-toast');
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    mockAdjustBalance.mockResolvedValue({});
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const { balanceBtn } = getActionButtons();
    fireEvent.click(balanceBtn);

    await userEvent.type(screen.getByPlaceholderText('Amount (negative to deduct)'), '10.50');
    await userEvent.type(screen.getByPlaceholderText('Reason'), 'Bonus credit');

    fireEvent.click(screen.getByRole('button', { name: 'Adjust Balance' }));

    await waitFor(() => {
      expect(mockAdjustBalance).toHaveBeenCalledWith('user-1', 10.5, 'Bonus credit');
      expect(toast.default.success).toHaveBeenCalledWith('Balance adjusted');
    });
  });

  it('successfully updates limits via modal', async () => {
    const toast = await import('react-hot-toast');
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    mockUpdateLimits.mockResolvedValue({});
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    const { limitsBtn } = getActionButtons();
    fireEvent.click(limitsBtn);

    const limitInputs = screen.getAllByPlaceholderText('Leave empty to keep current');
    await userEvent.type(limitInputs[0], '5.00');

    fireEvent.click(screen.getByRole('button', { name: 'Update Limits' }));

    await waitFor(() => {
      expect(mockUpdateLimits).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ dailyLimitUsd: 5.0 })
      );
      expect(toast.default.success).toHaveBeenCalledWith('Limits updated');
    });
  });

  it('refresh button re-fetches users', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Refresh'));
    expect(mockGetUsers).toHaveBeenCalledTimes(2);
  });

  it('displays "Never" for null last_request_at', async () => {
    mockGetUsers.mockResolvedValue({ data: mockUsersData });
    render(<AdminUsersPage />);

    await waitFor(() => {
      expect(screen.getByText('Never')).toBeInTheDocument();
    });
  });
});
