import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

interface AppConfig {
  appName: string;
  registrationEnabled: boolean;
}

interface AppConfigContextType {
  appName: string;
  registrationEnabled: boolean;
  // FE-R3: Consumers must not act on `registrationEnabled` until the first
  // /api/config response has arrived (`isLoading`), and must tell the user when
  // it could not be loaded (`loadFailed`) instead of silently assuming "closed".
  isLoading: boolean;
  loadFailed: boolean;
  reload: () => void;
}

const AppConfigContext = createContext<AppConfigContextType | null>(null);

async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`GET /api/config failed: ${res.status}`);
  return res.json() as Promise<AppConfig>;
}

export function AppConfigProvider({ children }: { children: React.ReactNode }) {
  const [appName, setAppName] = useState('ShortLink');
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // Reloads keep the last known values on screen; only the first load shows as
  // `isLoading`.
  const load = useCallback(() => {
    fetchConfig()
      .then((c) => {
        setAppName(c.appName);
        setRegistrationEnabled(c.registrationEnabled);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AppConfigContext.Provider
      value={{
        appName,
        registrationEnabled,
        isLoading,
        loadFailed,
        reload: load,
      }}
    >
      {children}
    </AppConfigContext.Provider>
  );
}

export function useAppConfig(): AppConfigContextType {
  const ctx = useContext(AppConfigContext);
  if (!ctx)
    throw new Error('useAppConfig must be used inside AppConfigProvider');
  return ctx;
}
