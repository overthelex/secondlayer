import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useGetIdentity } from '@refinedev/core';
import axios from 'axios';

interface EULAContextType {
  hasAccepted: boolean;
  loading: boolean;
  showModal: boolean;
  checkAcceptance: () => Promise<void>;
  acceptEULA: () => Promise<void>;
  openModal: () => void;
  closeModal: () => void;
}

const EULAContext = createContext<EULAContextType | undefined>(undefined);

interface EULAProviderProps {
  children: ReactNode;
}

export const EULAProvider: React.FC<EULAProviderProps> = ({ children }) => {
  const [hasAccepted, setHasAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const { data: identity } = useGetIdentity();

  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

  const getAuthToken = () => {
    return localStorage.getItem('auth_token');
  };

  const checkAcceptance = async () => {
    // Only check if user is authenticated
    if (!identity) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const token = getAuthToken();

      if (!token) {
        setLoading(false);
        return;
      }

      const response = await axios.get(`${apiUrl}/eula/status`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.data.success) {
        const accepted = response.data.data.hasAccepted;
        setHasAccepted(accepted);

        // Show modal if not accepted
        if (!accepted) {
          setShowModal(true);
        }
      }
    } catch (error) {
      console.error('Error checking EULA acceptance:', error);
      // Don't show modal on error - user might not be logged in yet
    } finally {
      setLoading(false);
    }
  };

  const acceptEULA = async () => {
    try {
      const token = getAuthToken();

      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await axios.post(
        `${apiUrl}/eula/accept`,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.data.success) {
        setHasAccepted(true);
        setShowModal(false);
      }
    } catch (error) {
      console.error('Error accepting EULA:', error);
      throw error;
    }
  };

  const openModal = () => setShowModal(true);
  const closeModal = () => {
    // Only allow closing if already accepted
    if (hasAccepted) {
      setShowModal(false);
    }
  };

  // Check acceptance when user identity changes (login/logout)
  useEffect(() => {
    if (identity) {
      checkAcceptance();
    } else {
      setHasAccepted(false);
      setShowModal(false);
      setLoading(false);
    }
  }, [identity]);

  return (
    <EULAContext.Provider
      value={{
        hasAccepted,
        loading,
        showModal,
        checkAcceptance,
        acceptEULA,
        openModal,
        closeModal,
      }}
    >
      {children}
    </EULAContext.Provider>
  );
};

export const useEULA = () => {
  const context = useContext(EULAContext);
  if (!context) {
    throw new Error('useEULA must be used within EULAProvider');
  }
  return context;
};
