/**
 * Person Domain Model (Judge/Lawyer)
 */

export interface Person {
  id: string;
  name: string;
  position: string;
  cases: number;
  successRate: number;
  specialization: string;
}

export interface Judge extends Person {
  court: string;
  approvalRate: number;
}

export interface Lawyer extends Person {
  firm: string;
  barNumber?: string;
}

export interface PersonDetail {
  type: 'judge' | 'lawyer';
  data: Person;
}
