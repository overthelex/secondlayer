/**
 * Admin Billing Dashboard - React Component Template
 *
 * This is a starter template for the admin billing dashboard.
 * To use this:
 * 1. Create a new React app: npx create-react-app admin-dashboard --template typescript
 * 2. Install dependencies: npm install recharts axios @types/recharts
 * 3. Copy components from this file into your src/ directory
 * 4. Configure API base URL in config
 * 5. Add routing with react-router-dom
 */

import React, { useState, useEffect } from 'react';
import axios from 'axios';

// ========================================
// Configuration
// ========================================

const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://dev.legal.org.ua';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add JWT token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('jwt_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ========================================
// Types
// ========================================

interface DashboardStats {
  today: {
    revenue_usd: number;
    profit_usd: number;
    requests: number;
  };
  month: {
    revenue_usd: number;
    profit_usd: number;
    requests: number;
  };
  users: {
    total: number;
    active: number;
    low_balance: number;
  };
  alerts: {
    failed_requests_today: number;
  };
}

interface User {
  id: string;
  email: string;
  created_at: string;
  balance_usd: number;
  total_spent_usd: number;
  pricing_tier: string;
  daily_limit_usd: number;
  monthly_limit_usd: number;
  total_requests: number;
  last_request_at: string | null;
}

interface Transaction {
  id: string;
  user_id: string;
  transaction_type: string;
  amount_usd: number;
  status: string;
  created_at: string;
  user_email?: string;
}

// ========================================
// Dashboard Component
// ========================================

export const AdminDashboard: React.FC = () => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, []);

  const loadStats = async () => {
    try {
      const response = await api.get('/api/admin/stats/overview');
      setStats(response.data);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load statistics');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="loading">Loading dashboard...</div>;
  }

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  if (!stats) {
    return <div className="error">No data available</div>;
  }

  return (
    <div className="admin-dashboard">
      <h1>Admin Billing Dashboard</h1>

      {/* Today's Stats */}
      <section className="stats-cards">
        <div className="stat-card">
          <h3>Today's Revenue</h3>
          <div className="stat-value">${stats.today.revenue_usd.toFixed(2)}</div>
          <div className="stat-label">Profit: ${stats.today.profit_usd.toFixed(2)}</div>
        </div>

        <div className="stat-card">
          <h3>Today's Requests</h3>
          <div className="stat-value">{stats.today.requests}</div>
        </div>

        <div className="stat-card">
          <h3>Month Revenue</h3>
          <div className="stat-value">${stats.month.revenue_usd.toFixed(2)}</div>
          <div className="stat-label">Profit: ${stats.month.profit_usd.toFixed(2)}</div>
        </div>

        <div className="stat-card">
          <h3>Total Users</h3>
          <div className="stat-value">{stats.users.total}</div>
          <div className="stat-label">Active: {stats.users.active}</div>
        </div>
      </section>

      {/* Alerts */}
      {(stats.alerts.failed_requests_today > 0 || stats.users.low_balance > 0) && (
        <section className="alerts">
          <h2>Alerts</h2>
          {stats.alerts.failed_requests_today > 0 && (
            <div className="alert alert-warning">
              ⚠️ {stats.alerts.failed_requests_today} failed requests today
            </div>
          )}
          {stats.users.low_balance > 0 && (
            <div className="alert alert-info">
              💰 {stats.users.low_balance} users with low balance (&lt; $5)
            </div>
          )}
        </section>
      )}
    </div>
  );
};

// ========================================
// User Management Component
// ========================================

export const UserManagement: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTier, setSelectedTier] = useState<string>('');
  const [pagination, setPagination] = useState({
    limit: 20,
    offset: 0,
    total: 0,
  });

  useEffect(() => {
    loadUsers();
  }, [searchTerm, selectedTier, pagination.offset]);

  const loadUsers = async () => {
    try {
      setLoading(true);
      const params: any = {
        limit: pagination.limit,
        offset: pagination.offset,
      };

      if (searchTerm) params.search = searchTerm;
      if (selectedTier) params.tier = selectedTier;

      const response = await api.get('/api/admin/users', { params });
      setUsers(response.data.users);
      setPagination((prev) => ({
        ...prev,
        total: response.data.pagination.total,
      }));
    } catch (err: any) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  };

  const adjustBalance = async (userId: string, amount: number, reason: string) => {
    try {
      await api.post(`/api/admin/users/${userId}/adjust-balance`, {
        amount,
        reason,
      });
      loadUsers(); // Reload users
      alert('Balance adjusted successfully');
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to adjust balance');
    }
  };

  const updateTier = async (userId: string, tier: string) => {
    try {
      await api.put(`/api/admin/users/${userId}/tier`, { tier });
      loadUsers(); // Reload users
      alert('Tier updated successfully');
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update tier');
    }
  };

  return (
    <div className="user-management">
      <h1>User Management</h1>

      {/* Filters */}
      <div className="filters">
        <input
          type="text"
          placeholder="Search by email or ID..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-input"
        />

        <select
          value={selectedTier}
          onChange={(e) => setSelectedTier(e.target.value)}
          className="tier-select"
        >
          <option value="">All Tiers</option>
          <option value="free">Free</option>
          <option value="startup">Startup</option>
          <option value="business">Business</option>
          <option value="enterprise">Enterprise</option>
          <option value="internal">Internal</option>
        </select>
      </div>

      {/* User Table */}
      {loading ? (
        <div className="loading">Loading users...</div>
      ) : (
        <>
          <table className="user-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Tier</th>
                <th>Balance</th>
                <th>Total Spent</th>
                <th>Requests</th>
                <th>Last Request</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.email}</td>
                  <td>
                    <span className={`tier-badge tier-${user.pricing_tier}`}>
                      {user.pricing_tier}
                    </span>
                  </td>
                  <td>${user.balance_usd.toFixed(2)}</td>
                  <td>${user.total_spent_usd.toFixed(2)}</td>
                  <td>{user.total_requests}</td>
                  <td>
                    {user.last_request_at
                      ? new Date(user.last_request_at).toLocaleDateString()
                      : 'Never'}
                  </td>
                  <td>
                    <button
                      onClick={() => {
                        const amount = parseFloat(
                          prompt('Enter amount to add (negative to subtract):') || '0'
                        );
                        const reason = prompt('Enter reason:') || 'Manual adjustment';
                        if (amount !== 0) {
                          adjustBalance(user.id, amount, reason);
                        }
                      }}
                      className="btn btn-sm"
                    >
                      Adjust Balance
                    </button>
                    <button
                      onClick={() => {
                        const tier = prompt(
                          'Enter new tier (free/startup/business/enterprise/internal):'
                        );
                        if (tier) {
                          updateTier(user.id, tier);
                        }
                      }}
                      className="btn btn-sm"
                    >
                      Change Tier
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="pagination">
            <button
              onClick={() =>
                setPagination((prev) => ({
                  ...prev,
                  offset: Math.max(0, prev.offset - prev.limit),
                }))
              }
              disabled={pagination.offset === 0}
            >
              Previous
            </button>
            <span>
              Showing {pagination.offset + 1} -{' '}
              {Math.min(pagination.offset + pagination.limit, pagination.total)} of{' '}
              {pagination.total}
            </span>
            <button
              onClick={() =>
                setPagination((prev) => ({
                  ...prev,
                  offset: prev.offset + prev.limit,
                }))
              }
              disabled={pagination.offset + pagination.limit >= pagination.total}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// ========================================
// Transaction List Component
// ========================================

export const TransactionList: React.FC = () => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({
    type: '',
    status: '',
  });

  useEffect(() => {
    loadTransactions();
  }, [filter]);

  const loadTransactions = async () => {
    try {
      setLoading(true);
      const params: any = { limit: 50 };
      if (filter.type) params.type = filter.type;
      if (filter.status) params.status = filter.status;

      const response = await api.get('/api/admin/transactions', { params });
      setTransactions(response.data.transactions);
    } catch (err: any) {
      console.error('Failed to load transactions:', err);
    } finally {
      setLoading(false);
    }
  };

  const refundTransaction = async (transactionId: string) => {
    const reason = prompt('Enter refund reason:');
    if (!reason) return;

    try {
      await api.post(`/api/admin/transactions/${transactionId}/refund`, { reason });
      loadTransactions(); // Reload
      alert('Transaction refunded successfully');
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to refund transaction');
    }
  };

  return (
    <div className="transaction-list">
      <h1>Transactions</h1>

      {/* Filters */}
      <div className="filters">
        <select
          value={filter.type}
          onChange={(e) => setFilter((prev) => ({ ...prev, type: e.target.value }))}
        >
          <option value="">All Types</option>
          <option value="charge">Charge</option>
          <option value="topup">Top-up</option>
          <option value="refund">Refund</option>
          <option value="admin_credit">Admin Credit</option>
        </select>

        <select
          value={filter.status}
          onChange={(e) => setFilter((prev) => ({ ...prev, status: e.target.value }))}
        >
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="refunded">Refunded</option>
        </select>
      </div>

      {/* Transaction Table */}
      {loading ? (
        <div className="loading">Loading transactions...</div>
      ) : (
        <table className="transaction-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>User</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx) => (
              <tr key={tx.id}>
                <td>{tx.id.slice(0, 8)}...</td>
                <td>{tx.user_email || tx.user_id.slice(0, 8)}</td>
                <td>{tx.transaction_type}</td>
                <td>${tx.amount_usd.toFixed(2)}</td>
                <td>
                  <span className={`status-badge status-${tx.status}`}>{tx.status}</span>
                </td>
                <td>{new Date(tx.created_at).toLocaleString()}</td>
                <td>
                  {tx.status === 'completed' && tx.transaction_type === 'charge' && (
                    <button
                      onClick={() => refundTransaction(tx.id)}
                      className="btn btn-sm btn-warning"
                    >
                      Refund
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ========================================
// Main App Component (Router Example)
// ========================================

export const AdminApp: React.FC = () => {
  const [currentView, setCurrentView] = useState<'dashboard' | 'users' | 'transactions'>(
    'dashboard'
  );

  return (
    <div className="admin-app">
      <nav className="admin-nav">
        <h1>SecondLayer Admin</h1>
        <ul>
          <li>
            <button onClick={() => setCurrentView('dashboard')}>Dashboard</button>
          </li>
          <li>
            <button onClick={() => setCurrentView('users')}>Users</button>
          </li>
          <li>
            <button onClick={() => setCurrentView('transactions')}>Transactions</button>
          </li>
        </ul>
      </nav>

      <main className="admin-content">
        {currentView === 'dashboard' && <AdminDashboard />}
        {currentView === 'users' && <UserManagement />}
        {currentView === 'transactions' && <TransactionList />}
      </main>
    </div>
  );
};

// ========================================
// Styles (basic CSS-in-JS or use CSS file)
// ========================================

export const adminStyles = `
  .admin-app {
    display: flex;
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .admin-nav {
    width: 250px;
    background: #1a1a2e;
    color: white;
    padding: 2rem 1rem;
  }

  .admin-nav h1 {
    font-size: 1.5rem;
    margin-bottom: 2rem;
  }

  .admin-nav ul {
    list-style: none;
    padding: 0;
  }

  .admin-nav li {
    margin-bottom: 1rem;
  }

  .admin-nav button {
    background: none;
    border: none;
    color: white;
    cursor: pointer;
    font-size: 1rem;
    padding: 0.5rem 1rem;
    width: 100%;
    text-align: left;
    border-radius: 4px;
    transition: background 0.2s;
  }

  .admin-nav button:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .admin-content {
    flex: 1;
    padding: 2rem;
    background: #f5f5f5;
  }

  .stats-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1.5rem;
    margin-bottom: 2rem;
  }

  .stat-card {
    background: white;
    padding: 1.5rem;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .stat-card h3 {
    font-size: 0.875rem;
    color: #666;
    margin: 0 0 0.5rem;
    text-transform: uppercase;
  }

  .stat-value {
    font-size: 2rem;
    font-weight: bold;
    color: #1a1a2e;
  }

  .stat-label {
    font-size: 0.875rem;
    color: #888;
    margin-top: 0.5rem;
  }

  .alerts {
    margin-bottom: 2rem;
  }

  .alert {
    padding: 1rem;
    border-radius: 4px;
    margin-bottom: 0.5rem;
  }

  .alert-warning {
    background: #fff3cd;
    color: #856404;
    border-left: 4px solid #ffc107;
  }

  .alert-info {
    background: #d1ecf1;
    color: #0c5460;
    border-left: 4px solid #17a2b8;
  }

  table {
    width: 100%;
    background: white;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  thead {
    background: #1a1a2e;
    color: white;
  }

  th, td {
    padding: 1rem;
    text-align: left;
  }

  tbody tr:hover {
    background: #f9f9f9;
  }

  .tier-badge {
    padding: 0.25rem 0.75rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: bold;
    text-transform: uppercase;
  }

  .tier-free { background: #e0e0e0; color: #666; }
  .tier-startup { background: #d4edda; color: #155724; }
  .tier-business { background: #cce5ff; color: #004085; }
  .tier-enterprise { background: #f8d7da; color: #721c24; }
  .tier-internal { background: #d1ecf1; color: #0c5460; }

  .status-badge {
    padding: 0.25rem 0.75rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: bold;
  }

  .status-pending { background: #fff3cd; color: #856404; }
  .status-completed { background: #d4edda; color: #155724; }
  .status-failed { background: #f8d7da; color: #721c24; }
  .status-refunded { background: #e0e0e0; color: #666; }

  .btn {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: background 0.2s;
  }

  .btn-sm {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    margin-right: 0.25rem;
  }

  .btn:hover {
    opacity: 0.9;
  }

  .btn-warning {
    background: #ffc107;
    color: #000;
  }

  .filters {
    margin-bottom: 1.5rem;
    display: flex;
    gap: 1rem;
  }

  .search-input, .tier-select {
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 1rem;
  }

  .search-input {
    flex: 1;
    max-width: 400px;
  }

  .pagination {
    margin-top: 1.5rem;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 1rem;
  }

  .pagination button {
    padding: 0.5rem 1rem;
    border: 1px solid #ddd;
    background: white;
    border-radius: 4px;
    cursor: pointer;
  }

  .pagination button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .loading, .error {
    text-align: center;
    padding: 2rem;
    font-size: 1.125rem;
  }

  .error {
    color: #dc3545;
  }
`;
