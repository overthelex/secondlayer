/**
 * OrganizationSetupModal + AuthGuard Integration Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OrganizationSetupModal } from '../OrganizationSetupModal';

// Mock react-hot-toast
vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock framer-motion to avoid animation issues in tests
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: any) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: any) => {
      const { initial, animate, exit, transition, ...domProps } = props;
      return <div {...domProps}>{children}</div>;
    },
  },
}));

// Mock api-client
const mockGetOrganization = vi.fn();
const mockCreateOrganization = vi.fn();

vi.mock('../../../utils/api-client', () => ({
  default: {},
  api: {
    team: {
      getOrganization: () => mockGetOrganization(),
      createOrganization: (data: any) => mockCreateOrganization(data),
    },
  },
}));

describe('OrganizationSetupModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onCreated: vi.fn(),
    userEmail: 'test@example.com',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('renders when open', () => {
    render(<OrganizationSetupModal {...defaultProps} />);

    expect(screen.getByText('Налаштування організації')).toBeInTheDocument();
    expect(screen.getByLabelText(/Назва компанії/)).toBeInTheDocument();
    expect(screen.getByLabelText('ЄДРПОУ')).toBeInTheDocument();
    expect(screen.getByLabelText('Контактний email')).toBeInTheDocument();
    expect(screen.getByLabelText('Опис')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<OrganizationSetupModal {...defaultProps} isOpen={false} />);

    expect(screen.queryByText('Налаштування організації')).not.toBeInTheDocument();
  });

  it('pre-fills contact email from user email', () => {
    render(<OrganizationSetupModal {...defaultProps} />);

    const emailInput = screen.getByLabelText('Контактний email') as HTMLInputElement;
    expect(emailInput.value).toBe('test@example.com');
  });

  it('disables save button when name is empty', () => {
    render(<OrganizationSetupModal {...defaultProps} />);

    const saveButton = screen.getByText('Зберегти');
    expect(saveButton).toBeDisabled();
  });

  it('enables save button when name is filled', async () => {
    render(<OrganizationSetupModal {...defaultProps} />);

    const nameInput = screen.getByLabelText(/Назва компанії/);
    await userEvent.type(nameInput, 'Test Company');

    const saveButton = screen.getByText('Зберегти');
    expect(saveButton).not.toBeDisabled();
  });

  it('calls onClose and sets sessionStorage on skip', async () => {
    render(<OrganizationSetupModal {...defaultProps} />);

    const skipButton = screen.getByText('Пропустити');
    await userEvent.click(skipButton);

    expect(defaultProps.onClose).toHaveBeenCalled();
    expect(sessionStorage.getItem('org_setup_skipped')).toBe('1');
  });

  it('calls createOrganization and onCreated on submit', async () => {
    mockCreateOrganization.mockResolvedValue({ data: { success: true, data: { id: '1', name: 'Test' } } });

    render(<OrganizationSetupModal {...defaultProps} />);

    const nameInput = screen.getByLabelText(/Назва компанії/);
    await userEvent.type(nameInput, 'My Law Firm');

    const saveButton = screen.getByText('Зберегти');
    await userEvent.click(saveButton);

    await waitFor(() => {
      expect(mockCreateOrganization).toHaveBeenCalledWith({
        name: 'My Law Firm',
        taxId: undefined,
        contactEmail: 'test@example.com',
        description: undefined,
      });
      expect(defaultProps.onCreated).toHaveBeenCalled();
    });
  });

  it('sends all fields when filled', async () => {
    mockCreateOrganization.mockResolvedValue({ data: { success: true } });

    render(<OrganizationSetupModal {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/Назва компанії/), 'ТОВ Юрком');
    await userEvent.clear(screen.getByLabelText('Контактний email'));
    await userEvent.type(screen.getByLabelText('Контактний email'), 'office@firm.ua');
    await userEvent.type(screen.getByLabelText('ЄДРПОУ'), '12345678');
    await userEvent.type(screen.getByLabelText('Опис'), 'Legal services');

    await userEvent.click(screen.getByText('Зберегти'));

    await waitFor(() => {
      expect(mockCreateOrganization).toHaveBeenCalledWith({
        name: 'ТОВ Юрком',
        taxId: '12345678',
        contactEmail: 'office@firm.ua',
        description: 'Legal services',
      });
    });
  });

  it('shows error toast on API failure', async () => {
    const toast = await import('react-hot-toast');
    mockCreateOrganization.mockRejectedValue({
      response: { data: { error: 'DB error' } },
    });

    render(<OrganizationSetupModal {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/Назва компанії/), 'Test');
    await userEvent.click(screen.getByText('Зберегти'));

    await waitFor(() => {
      expect(toast.default.error).toHaveBeenCalledWith('DB error');
      expect(defaultProps.onCreated).not.toHaveBeenCalled();
    });
  });
});

describe('AuthGuard organization check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('shows modal when user has no organization', async () => {
    mockGetOrganization.mockResolvedValue({ data: { success: true, data: null } });

    // Mock useAuth
    vi.doMock('../../../contexts/AuthContext', () => ({
      useAuth: () => ({
        user: { id: '1', email: 'test@example.com', name: 'Test' },
        token: 'jwt-token',
        isAuthenticated: true,
        isLoading: false,
        login: vi.fn(),
        logout: vi.fn(),
        refreshToken: vi.fn(),
        updateUser: vi.fn(),
      }),
    }));

    // Dynamic import after mock
    const { AuthGuard } = await import('../../../router/guards/AuthGuard');

    render(
      <MemoryRouter>
        <AuthGuard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Налаштування організації')).toBeInTheDocument();
    });
  });

  it('does not show modal when user has organization', async () => {
    mockGetOrganization.mockResolvedValue({
      data: { success: true, data: { id: '1', name: 'My Org' } },
    });

    vi.doMock('../../../contexts/AuthContext', () => ({
      useAuth: () => ({
        user: { id: '1', email: 'test@example.com', name: 'Test' },
        token: 'jwt-token',
        isAuthenticated: true,
        isLoading: false,
        login: vi.fn(),
        logout: vi.fn(),
        refreshToken: vi.fn(),
        updateUser: vi.fn(),
      }),
    }));

    const { AuthGuard } = await import('../../../router/guards/AuthGuard');

    render(
      <MemoryRouter>
        <AuthGuard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockGetOrganization).toHaveBeenCalled();
    });

    expect(screen.queryByText('Налаштування організації')).not.toBeInTheDocument();
  });

  it('does not show modal when session has skip flag', async () => {
    sessionStorage.setItem('org_setup_skipped', '1');
    mockGetOrganization.mockResolvedValue({ data: { success: true, data: null } });

    vi.doMock('../../../contexts/AuthContext', () => ({
      useAuth: () => ({
        user: { id: '1', email: 'test@example.com', name: 'Test' },
        token: 'jwt-token',
        isAuthenticated: true,
        isLoading: false,
        login: vi.fn(),
        logout: vi.fn(),
        refreshToken: vi.fn(),
        updateUser: vi.fn(),
      }),
    }));

    const { AuthGuard } = await import('../../../router/guards/AuthGuard');

    render(
      <MemoryRouter>
        <AuthGuard />
      </MemoryRouter>
    );

    // Should not even call the API
    await new Promise((r) => setTimeout(r, 100));
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(screen.queryByText('Налаштування організації')).not.toBeInTheDocument();
  });
});
