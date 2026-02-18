/**
 * Team Management Domain Models
 */

export interface TeamMember {
  id: string;
  name: string;
  initials: string;
  email: string;
  role: 'owner' | 'admin' | 'user' | 'observer';
  requests: number | null;
  cost: string | null;
  lastActive: string;
  status: 'active' | 'inactive' | 'pending';
  avatarColor: 'blue' | 'green' | 'yellow' | 'purple' | 'red' | 'gray';
}

export interface TeamStats {
  totalMembers: number;
  activeUsers: number;
  teamRequests: number;
  teamCost: number;
}

export interface Organization {
  id: string;
  name: string;
  ownerId: string;
  plan: string;
  maxMembers: number;
  createdAt: Date;
}

export interface PermissionRow {
  name: string;
  owner: boolean;
  admin: boolean;
  user: boolean;
  observer: boolean;
}

export interface InviteMemberRequest {
  email: string;
  role: 'admin' | 'user' | 'observer';
}

export interface InviteMemberResponse {
  id: string;
  email: string;
  role: string;
  invitedAt: string;
}

export interface UpdateMemberRequest {
  role: string;
}

// Billing extended types
export interface UsageChartData {
  date: string;
  requests: number;
  cost: number;
}

export interface PaymentMethod {
  id: string;
  provider: 'stripe' | 'metamask' | 'binance_pay';
  cardLast4: string;
  cardBrand: string;
  cardBank: string;
  isPrimary: boolean;
}

export interface BillingStatistics {
  period: string;
  totalRequests: number;
  totalCost: number;
  openaiTokens: number;
  avgCostPerRequest: number;
  costByService: CostByService[];
  topTools: ToolUsage[];
}

export interface CostByService {
  name: string;
  value: number;
  color: string;
}

export interface ToolUsage {
  name: string;
  count: number;
  percentage: number;
}

export interface PricingPlan {
  id: string;
  name: string;
  price: number;
  billingCycle: 'monthly' | 'yearly';
  features: string[];
  isCurrentPlan: boolean;
  limits: {
    monthlyRequests: number;
    dailyRequests: number;
    teamMembers: number;
  };
}
