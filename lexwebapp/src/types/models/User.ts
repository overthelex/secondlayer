/**
 * User Domain Model
 */

export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified?: boolean;
  lastLogin?: string;
  createdAt?: string;
}

export interface UserProfile extends User {
  // Extended user profile fields
  phone?: string;
  company?: string;
  role?: 'lawyer' | 'client' | 'admin';
}
