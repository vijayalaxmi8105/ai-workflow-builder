'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

type OrgInfo = { id: string; role: string; name: string };
type UserInfo = { id: string; email: string; name: string | null };

type AuthContextType = {
  user: UserInfo | null;
  org: OrgInfo | null;
  availableOrgs: OrgInfo[];
  loading: boolean;
  login: (email: string, orgId?: string) => Promise<void>;
  logout: () => void;
  switchOrg: (orgId: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [availableOrgs, setAvailableOrgs] = useState<OrgInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastEmail, setLastEmail] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    const storedUser = localStorage.getItem('auth_user');
    const storedOrg = localStorage.getItem('auth_org');
    const storedOrgs = localStorage.getItem('auth_available_orgs');
    const storedEmail = localStorage.getItem('auth_email');
    if (token && storedUser && storedOrg) {
      setUser(JSON.parse(storedUser));
      setOrg(JSON.parse(storedOrg));
      setAvailableOrgs(storedOrgs ? JSON.parse(storedOrgs) : []);
      setLastEmail(storedEmail);
    }
    setLoading(false);
  }, []);

  async function login(email: string, orgId?: string) {
    const res = await fetch(`${SERVER_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, org_id: orgId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: 'Login failed' }));
      throw new Error(err.message || 'Login failed');
    }
    const data = await res.json();
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('auth_user', JSON.stringify(data.user));
    localStorage.setItem('auth_org', JSON.stringify(data.org));
    localStorage.setItem('auth_available_orgs', JSON.stringify(data.available_orgs));
    localStorage.setItem('auth_email', email);
    setUser(data.user);
    setOrg(data.org);
    setAvailableOrgs(data.available_orgs);
    setLastEmail(email);
  }

  async function switchOrg(orgId: string) {
    if (!lastEmail) throw new Error('No active session to switch org for');
    await login(lastEmail, orgId);
  }

  function logout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    localStorage.removeItem('auth_org');
    localStorage.removeItem('auth_available_orgs');
    localStorage.removeItem('auth_email');
    setUser(null);
    setOrg(null);
    setAvailableOrgs([]);
    setLastEmail(null);
  }

  return (
    <AuthContext.Provider value={{ user, org, availableOrgs, loading, login, logout, switchOrg }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
