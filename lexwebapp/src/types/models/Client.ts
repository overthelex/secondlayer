/**
 * Client Domain Model
 */

export interface Client {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  activeCases: number;
  status: 'active' | 'inactive';
  lastContact: string;
  type: 'individual' | 'corporate';
}

export interface ClientDetail extends Client {
  address?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}
