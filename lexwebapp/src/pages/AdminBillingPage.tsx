/**
 * Admin Billing Management Page
 * 3 tabs: Pricing Tiers, Organizations, Subscriptions
 */

import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api-client';
import toast from 'react-hot-toast';

// ============================================================
// Types
// ============================================================

interface BillingTier {
  id: string;
  tier_key: string;
  display_name: string;
  markup_percentage: number;
  description: string;
  features: string[];
  default_daily_limit_usd: number;
  default_monthly_limit_usd: number;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
}

interface VolumeDiscount {
  id: string;
  min_monthly_spend_usd: number;
  discount_percentage: number;
}

interface Organization {
  id: string;
  name: string;
  plan: string;
  max_members: number;
  billing_tier_key: string | null;
  billing_email: string | null;
  balance_usd: number;
  total_spent_usd: number;
  member_count: number;
  owner_email: string;
  owner_name: string;
  created_at: string;
}

interface Subscription {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  tier_key: string;
  status: string;
  billing_cycle: string;
  price_usd: number;
  trial_ends_at: string | null;
  next_billing_date: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  user_email?: string;
  user_name?: string;
  org_name?: string;
  tier_display_name?: string;
}

// ============================================================
// Status Badge
// ============================================================

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-800',
    trial: 'bg-blue-100 text-blue-800',
    past_due: 'bg-yellow-100 text-yellow-800',
    canceled: 'bg-red-100 text-red-800',
    expired: 'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

// ============================================================
// Tiers Tab
// ============================================================

function TiersTab() {
  const [tiers, setTiers] = useState<BillingTier[]>([]);
  const [discounts, setDiscounts] = useState<VolumeDiscount[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingTier, setEditingTier] = useState<BillingTier | null>(null);
  const [editingDiscounts, setEditingDiscounts] = useState(false);
  const [discountDraft, setDiscountDraft] = useState<Array<{ min_monthly_spend_usd: number; discount_percentage: number }>>([]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [tiersRes, discountsRes] = await Promise.all([
        api.admin.getBillingTiers(),
        api.admin.getVolumeDiscounts(),
      ]);
      setTiers(tiersRes.data.tiers || []);
      setDiscounts(discountsRes.data.discounts || []);
    } catch {
      toast.error('Failed to load tiers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSaveTier = async () => {
    if (!editingTier) return;
    try {
      await api.admin.updateBillingTier(editingTier.id, {
        display_name: editingTier.display_name,
        markup_percentage: editingTier.markup_percentage,
        description: editingTier.description,
        features: editingTier.features,
        default_daily_limit_usd: editingTier.default_daily_limit_usd,
        default_monthly_limit_usd: editingTier.default_monthly_limit_usd,
      });
      toast.success('Tier updated');
      setEditingTier(null);
      load();
    } catch {
      toast.error('Failed to update tier');
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await api.admin.setDefaultTier(id);
      toast.success('Default tier updated');
      load();
    } catch {
      toast.error('Failed to set default');
    }
  };

  const handleDeactivate = async (id: string) => {
    try {
      await api.admin.deleteBillingTier(id);
      toast.success('Tier deactivated');
      load();
    } catch {
      toast.error('Failed to deactivate tier');
    }
  };

  const handleSaveDiscounts = async () => {
    try {
      await api.admin.updateVolumeDiscounts(discountDraft);
      toast.success('Volume discounts updated');
      setEditingDiscounts(false);
      load();
    } catch {
      toast.error('Failed to update discounts');
    }
  };

  if (loading) return <div className="p-6 text-center text-gray-500">Loading...</div>;

  return (
    <div className="space-y-6">
      {/* Tiers Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-sm text-gray-800">Pricing Tiers</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Tier</th>
                <th className="px-4 py-2 text-left">Display Name</th>
                <th className="px-4 py-2 text-right">Markup %</th>
                <th className="px-4 py-2 text-right">Daily Limit</th>
                <th className="px-4 py-2 text-right">Monthly Limit</th>
                <th className="px-4 py-2 text-center">Default</th>
                <th className="px-4 py-2 text-center">Active</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {tiers.map((tier) => (
                <tr key={tier.id} className={!tier.is_active ? 'opacity-50' : ''}>
                  <td className="px-4 py-2 font-mono text-xs">{tier.tier_key}</td>
                  <td className="px-4 py-2">{tier.display_name}</td>
                  <td className="px-4 py-2 text-right">{tier.markup_percentage}%</td>
                  <td className="px-4 py-2 text-right">${tier.default_daily_limit_usd}</td>
                  <td className="px-4 py-2 text-right">${tier.default_monthly_limit_usd}</td>
                  <td className="px-4 py-2 text-center">
                    {tier.is_default ? (
                      <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs">Default</span>
                    ) : (
                      <button
                        onClick={() => handleSetDefault(tier.id)}
                        className="text-xs text-gray-400 hover:text-blue-600"
                      >
                        Set
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span className={`w-2 h-2 rounded-full inline-block ${tier.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                  </td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <button
                      onClick={() => setEditingTier({ ...tier })}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      Edit
                    </button>
                    {tier.is_active && !tier.is_default && (
                      <button
                        onClick={() => handleDeactivate(tier.id)}
                        className="text-xs text-red-500 hover:underline"
                      >
                        Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Tier Modal */}
      {editingTier && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setEditingTier(null)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">Edit Tier: {editingTier.tier_key}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Display Name</label>
                <input
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={editingTier.display_name}
                  onChange={(e) => setEditingTier({ ...editingTier, display_name: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Markup %</label>
                  <input
                    type="number"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    value={editingTier.markup_percentage}
                    onChange={(e) => setEditingTier({ ...editingTier, markup_percentage: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Daily Limit $</label>
                  <input
                    type="number"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    value={editingTier.default_daily_limit_usd}
                    onChange={(e) => setEditingTier({ ...editingTier, default_daily_limit_usd: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Monthly Limit $</label>
                  <input
                    type="number"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    value={editingTier.default_monthly_limit_usd}
                    onChange={(e) => setEditingTier({ ...editingTier, default_monthly_limit_usd: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Description</label>
                <textarea
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  rows={2}
                  value={editingTier.description}
                  onChange={(e) => setEditingTier({ ...editingTier, description: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Features (one per line)</label>
                <textarea
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  rows={4}
                  value={editingTier.features.join('\n')}
                  onChange={(e) => setEditingTier({ ...editingTier, features: e.target.value.split('\n').filter(Boolean) })}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setEditingTier(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button onClick={handleSaveTier} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Volume Discounts */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-sm text-gray-800">Volume Discounts</h3>
          <button
            onClick={() => {
              setDiscountDraft(discounts.map(d => ({ min_monthly_spend_usd: d.min_monthly_spend_usd, discount_percentage: d.discount_percentage })));
              setEditingDiscounts(true);
            }}
            className="text-xs text-blue-600 hover:underline"
          >
            Edit
          </button>
        </div>
        {editingDiscounts ? (
          <div className="p-4 space-y-2">
            {discountDraft.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-gray-500">$</span>
                <input
                  type="number"
                  className="w-24 border rounded px-2 py-1 text-sm"
                  value={d.min_monthly_spend_usd}
                  onChange={(e) => {
                    const next = [...discountDraft];
                    next[i] = { ...next[i], min_monthly_spend_usd: Number(e.target.value) };
                    setDiscountDraft(next);
                  }}
                />
                <span className="text-xs text-gray-500">spend/mo =</span>
                <input
                  type="number"
                  className="w-20 border rounded px-2 py-1 text-sm"
                  value={d.discount_percentage}
                  onChange={(e) => {
                    const next = [...discountDraft];
                    next[i] = { ...next[i], discount_percentage: Number(e.target.value) };
                    setDiscountDraft(next);
                  }}
                />
                <span className="text-xs text-gray-500">% off</span>
                <button onClick={() => setDiscountDraft(discountDraft.filter((_, j) => j !== i))} className="text-red-400 text-xs hover:text-red-600">Remove</button>
              </div>
            ))}
            <button
              onClick={() => setDiscountDraft([...discountDraft, { min_monthly_spend_usd: 0, discount_percentage: 0 }])}
              className="text-xs text-blue-600 hover:underline"
            >
              + Add threshold
            </button>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditingDiscounts(false)} className="px-3 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded">Cancel</button>
              <button onClick={handleSaveDiscounts} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
            </div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Min Monthly Spend</th>
                <th className="px-4 py-2 text-left">Discount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {discounts.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-2">${d.min_monthly_spend_usd}</td>
                  <td className="px-4 py-2">{d.discount_percentage}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Organizations Tab
// ============================================================

function OrganizationsTab() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOrg, setExpandedOrg] = useState<string | null>(null);
  const [orgDetail, setOrgDetail] = useState<any>(null);
  const [editingOrg, setEditingOrg] = useState<Organization | null>(null);
  const [tiers, setTiers] = useState<BillingTier[]>([]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [orgsRes, tiersRes] = await Promise.all([
        api.admin.getOrganizations(),
        api.admin.getBillingTiers(),
      ]);
      setOrgs(orgsRes.data.organizations || []);
      setTiers(tiersRes.data.tiers?.filter((t: BillingTier) => t.is_active) || []);
    } catch {
      toast.error('Failed to load organizations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleExpand = async (orgId: string) => {
    if (expandedOrg === orgId) {
      setExpandedOrg(null);
      return;
    }
    try {
      const res = await api.admin.getOrganization(orgId);
      setOrgDetail(res.data);
      setExpandedOrg(orgId);
    } catch {
      toast.error('Failed to load org details');
    }
  };

  const handleSaveOrg = async () => {
    if (!editingOrg) return;
    try {
      await api.admin.updateOrganization(editingOrg.id, {
        plan: editingOrg.plan,
        max_members: editingOrg.max_members,
        billing_tier_key: editingOrg.billing_tier_key,
        billing_email: editingOrg.billing_email,
      });
      toast.success('Organization updated');
      setEditingOrg(null);
      load();
    } catch {
      toast.error('Failed to update organization');
    }
  };

  if (loading) return <div className="p-6 text-center text-gray-500">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-sm text-gray-800">Organizations ({orgs.length})</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-left">Plan</th>
                <th className="px-4 py-2 text-right">Members</th>
                <th className="px-4 py-2 text-left">Owner</th>
                <th className="px-4 py-2 text-right">Balance</th>
                <th className="px-4 py-2 text-right">Total Spent</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orgs.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No organizations found</td></tr>
              )}
              {orgs.map((org) => (
                <React.Fragment key={org.id}>
                  <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => handleExpand(org.id)}>
                    <td className="px-4 py-2 font-medium">{org.name}</td>
                    <td className="px-4 py-2">{org.plan || '-'}</td>
                    <td className="px-4 py-2 text-right">{org.member_count}/{org.max_members}</td>
                    <td className="px-4 py-2 text-xs text-gray-500">{org.owner_email}</td>
                    <td className="px-4 py-2 text-right">${org.balance_usd.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right">${org.total_spent_usd.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingOrg({ ...org }); }}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                  {expandedOrg === org.id && orgDetail && (
                    <tr>
                      <td colSpan={7} className="px-6 py-3 bg-gray-50">
                        <div className="text-xs font-semibold text-gray-500 mb-2">Members</div>
                        <div className="space-y-1">
                          {orgDetail.members?.map((m: any) => (
                            <div key={m.user_id} className="flex items-center gap-3 text-xs">
                              <span className="text-gray-800">{m.name || m.email}</span>
                              <span className="text-gray-400">{m.email}</span>
                              <span className="px-1.5 py-0.5 bg-gray-200 rounded text-gray-600">{m.role}</span>
                            </div>
                          ))}
                          {(!orgDetail.members || orgDetail.members.length === 0) && (
                            <span className="text-gray-400 text-xs">No members</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Org Modal */}
      {editingOrg && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setEditingOrg(null)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">Edit: {editingOrg.name}</h3>
            <div className="space-y-3">
              <div>
                <label htmlFor="edit-org-plan" className="block text-xs text-gray-500 mb-1">Plan</label>
                <input id="edit-org-plan" name="plan" className="w-full border rounded-lg px-3 py-2 text-sm" value={editingOrg.plan || ''} onChange={(e) => setEditingOrg({ ...editingOrg, plan: e.target.value })} />
              </div>
              <div>
                <label htmlFor="edit-org-max-members" className="block text-xs text-gray-500 mb-1">Max Members</label>
                <input id="edit-org-max-members" name="maxMembers" type="number" className="w-full border rounded-lg px-3 py-2 text-sm" value={editingOrg.max_members} onChange={(e) => setEditingOrg({ ...editingOrg, max_members: Number(e.target.value) })} />
              </div>
              <div>
                <label htmlFor="edit-org-billing-tier" className="block text-xs text-gray-500 mb-1">Billing Tier</label>
                <select id="edit-org-billing-tier" name="billingTier" className="w-full border rounded-lg px-3 py-2 text-sm" value={editingOrg.billing_tier_key || ''} onChange={(e) => setEditingOrg({ ...editingOrg, billing_tier_key: e.target.value || null })}>
                  <option value="">None</option>
                  {tiers.map(t => <option key={t.id} value={t.tier_key}>{t.display_name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="edit-org-billing-email" className="block text-xs text-gray-500 mb-1">Billing Email</label>
                <input id="edit-org-billing-email" name="billingEmail" className="w-full border rounded-lg px-3 py-2 text-sm" value={editingOrg.billing_email || ''} onChange={(e) => setEditingOrg({ ...editingOrg, billing_email: e.target.value || null })} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setEditingOrg(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button onClick={handleSaveOrg} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Subscriptions Tab
// ============================================================

function SubscriptionsTab() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [cancelModal, setCancelModal] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [tiers, setTiers] = useState<BillingTier[]>([]);

  // Create form
  const [createForm, setCreateForm] = useState({
    user_id: '', organization_id: '', tier_key: '', billing_cycle: 'monthly' as string, price_usd: 0, trial_ends_at: '',
  });

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [subsRes, tiersRes] = await Promise.all([
        api.admin.getSubscriptions({ status: statusFilter || undefined }),
        api.admin.getBillingTiers(),
      ]);
      setSubs(subsRes.data.subscriptions || []);
      setTotal(subsRes.data.total || 0);
      setTiers(tiersRes.data.tiers?.filter((t: BillingTier) => t.is_active) || []);
    } catch {
      toast.error('Failed to load subscriptions');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    try {
      await api.admin.createSubscription({
        user_id: createForm.user_id || undefined,
        organization_id: createForm.organization_id || undefined,
        tier_key: createForm.tier_key,
        billing_cycle: createForm.billing_cycle,
        price_usd: createForm.price_usd,
        trial_ends_at: createForm.trial_ends_at || undefined,
      });
      toast.success('Subscription created');
      setShowCreate(false);
      setCreateForm({ user_id: '', organization_id: '', tier_key: '', billing_cycle: 'monthly', price_usd: 0, trial_ends_at: '' });
      load();
    } catch {
      toast.error('Failed to create subscription');
    }
  };

  const handleCancel = async () => {
    if (!cancelModal) return;
    try {
      await api.admin.cancelSubscription(cancelModal, cancelReason || 'Admin canceled');
      toast.success('Subscription canceled');
      setCancelModal(null);
      setCancelReason('');
      load();
    } catch {
      toast.error('Failed to cancel subscription');
    }
  };

  const handleActivate = async (id: string) => {
    try {
      await api.admin.activateSubscription(id);
      toast.success('Subscription activated');
      load();
    } catch {
      toast.error('Failed to activate subscription');
    }
  };

  if (loading) return <div className="p-6 text-center text-gray-500">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <select
            className="border rounded-lg px-3 py-1.5 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="trial">Trial</option>
            <option value="past_due">Past Due</option>
            <option value="canceled">Canceled</option>
            <option value="expired">Expired</option>
          </select>
          <span className="text-xs text-gray-400">{total} total</span>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          + Create
        </button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">User / Org</th>
                <th className="px-4 py-2 text-left">Tier</th>
                <th className="px-4 py-2 text-center">Status</th>
                <th className="px-4 py-2 text-left">Cycle</th>
                <th className="px-4 py-2 text-right">Price</th>
                <th className="px-4 py-2 text-left">Next Billing</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {subs.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No subscriptions found</td></tr>
              )}
              {subs.map((sub) => (
                <tr key={sub.id}>
                  <td className="px-4 py-2">
                    {sub.user_email || sub.user_name || sub.org_name || (sub.user_id ? `User ${sub.user_id.slice(0, 8)}...` : `Org ${sub.organization_id?.slice(0, 8)}...`)}
                  </td>
                  <td className="px-4 py-2">{sub.tier_display_name || sub.tier_key}</td>
                  <td className="px-4 py-2 text-center"><StatusBadge status={sub.status} /></td>
                  <td className="px-4 py-2">{sub.billing_cycle}</td>
                  <td className="px-4 py-2 text-right">${sub.price_usd.toFixed(2)}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {sub.next_billing_date ? new Date(sub.next_billing_date).toLocaleDateString() : '-'}
                  </td>
                  <td className="px-4 py-2 text-right space-x-2">
                    {(sub.status === 'active' || sub.status === 'trial') && (
                      <button onClick={() => setCancelModal(sub.id)} className="text-xs text-red-500 hover:underline">Cancel</button>
                    )}
                    {sub.status === 'canceled' && (
                      <button onClick={() => handleActivate(sub.id)} className="text-xs text-green-600 hover:underline">Activate</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">Create Subscription</h3>
            <div className="space-y-3">
              <div>
                <label htmlFor="create-sub-user-id" className="block text-xs text-gray-500 mb-1">User ID (leave empty for org)</label>
                <input id="create-sub-user-id" name="userId" className="w-full border rounded-lg px-3 py-2 text-sm" value={createForm.user_id} onChange={(e) => setCreateForm({ ...createForm, user_id: e.target.value })} placeholder="UUID" />
              </div>
              <div>
                <label htmlFor="create-sub-org-id" className="block text-xs text-gray-500 mb-1">Organization ID (leave empty for user)</label>
                <input id="create-sub-org-id" name="organizationId" className="w-full border rounded-lg px-3 py-2 text-sm" value={createForm.organization_id} onChange={(e) => setCreateForm({ ...createForm, organization_id: e.target.value })} placeholder="UUID" />
              </div>
              <div>
                <label htmlFor="create-sub-tier" className="block text-xs text-gray-500 mb-1">Tier</label>
                <select id="create-sub-tier" name="tier" className="w-full border rounded-lg px-3 py-2 text-sm" value={createForm.tier_key} onChange={(e) => setCreateForm({ ...createForm, tier_key: e.target.value })}>
                  <option value="">Select tier</option>
                  {tiers.map(t => <option key={t.id} value={t.tier_key}>{t.display_name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="create-sub-billing-cycle" className="block text-xs text-gray-500 mb-1">Billing Cycle</label>
                  <select id="create-sub-billing-cycle" name="billingCycle" className="w-full border rounded-lg px-3 py-2 text-sm" value={createForm.billing_cycle} onChange={(e) => setCreateForm({ ...createForm, billing_cycle: e.target.value })}>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="annual">Annual</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="create-sub-price" className="block text-xs text-gray-500 mb-1">Price (USD)</label>
                  <input id="create-sub-price" name="priceUsd" type="number" step="0.01" className="w-full border rounded-lg px-3 py-2 text-sm" value={createForm.price_usd} onChange={(e) => setCreateForm({ ...createForm, price_usd: Number(e.target.value) })} />
                </div>
              </div>
              <div>
                <label htmlFor="create-sub-trial-ends" className="block text-xs text-gray-500 mb-1">Trial Ends At (optional)</label>
                <input id="create-sub-trial-ends" name="trialEndsAt" type="date" className="w-full border rounded-lg px-3 py-2 text-sm" value={createForm.trial_ends_at} onChange={(e) => setCreateForm({ ...createForm, trial_ends_at: e.target.value })} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button onClick={handleCreate} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700" disabled={!createForm.tier_key}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Modal */}
      {cancelModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setCancelModal(null)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-3">Cancel Subscription</h3>
            <div>
              <label htmlFor="cancel-sub-reason" className="block text-xs text-gray-500 mb-1">Reason</label>
              <textarea id="cancel-sub-reason" name="cancelReason" className="w-full border rounded-lg px-3 py-2 text-sm" rows={3} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Reason for cancellation..." />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setCancelModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Back</button>
              <button onClick={handleCancel} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Confirm Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Main Page Component
// ============================================================

export function AdminBillingPage() {
  const [tab, setTab] = useState<'tiers' | 'organizations' | 'subscriptions'>('tiers');

  const tabs = [
    { id: 'tiers' as const, label: 'Pricing Tiers' },
    { id: 'organizations' as const, label: 'Organizations' },
    { id: 'subscriptions' as const, label: 'Subscriptions' },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Tab Bar */}
        <div className="flex gap-1 border-b border-gray-200 mb-6">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {tab === 'tiers' && <TiersTab />}
        {tab === 'organizations' && <OrganizationsTab />}
        {tab === 'subscriptions' && <SubscriptionsTab />}
      </div>
    </div>
  );
}
