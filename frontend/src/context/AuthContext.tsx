import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { client, type User } from '@/api/client';

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName?: string) => Promise<void>;
  logout: () => Promise<void>;
  deactivateAccount: (currentPassword: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Remove tokens from the previous sessionStorage-based release.
    sessionStorage.removeItem('pdf-assistant-token');
    sessionStorage.removeItem('pdf-assistant-user');
    void client.me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    async login(email: string, password: string) {
      const nextUser = await client.login(email, password);
      setUser(nextUser);
    },
    async register(email: string, password: string, fullName?: string) {
      const created = await client.register({ email, password, full_name: fullName });
      setUser(created);
    },
    async logout() {
      try {
        await client.logout();
      } finally {
        setUser(null);
      }
    },
    async deactivateAccount(currentPassword: string) {
      await client.deactivateAccount(currentPassword);
      sessionStorage.removeItem('pdf-assistant-gemini-key');
      setUser(null);
    },
  }), [loading, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is missing');
  return context;
}