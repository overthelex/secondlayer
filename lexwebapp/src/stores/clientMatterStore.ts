/**
 * Client & Matter UI Store
 * Zustand store for client/matter navigation state
 */

import { create } from 'zustand';

type ClientDetailTab = 'overview' | 'matters' | 'documents' | 'activity' | 'compliance';
type MatterDetailTab = 'overview' | 'team' | 'holds' | 'documents' | 'activity';

interface ClientMatterState {
  activeClientId: string | null;
  activeMatterId: string | null;
  clientDetailTab: ClientDetailTab;
  matterDetailTab: MatterDetailTab;

  setActiveClient: (id: string | null) => void;
  setActiveMatter: (id: string | null) => void;
  setClientDetailTab: (tab: ClientDetailTab) => void;
  setMatterDetailTab: (tab: MatterDetailTab) => void;
}

export const useClientMatterStore = create<ClientMatterState>((set) => ({
  activeClientId: null,
  activeMatterId: null,
  clientDetailTab: 'overview',
  matterDetailTab: 'overview',

  setActiveClient: (id) => set({ activeClientId: id, clientDetailTab: 'overview' }),
  setActiveMatter: (id) => set({ activeMatterId: id, matterDetailTab: 'overview' }),
  setClientDetailTab: (tab) => set({ clientDetailTab: tab }),
  setMatterDetailTab: (tab) => set({ matterDetailTab: tab }),
}));
