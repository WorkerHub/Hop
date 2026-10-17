import { useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  authApi,
  type LoginResult,
  refreshSession,
  setAccessToken,
  setSessionExpiredHandler,
  type User,
} from '../api/client.ts';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  pendingToken: string | null;
  pendingMethods: string[];
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  broadcastRefresh: () => void;
  setPendingState: (token: string, methods: string[]) => void;
  clearPendingState: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

// FE-S1: The channel carries only a signal, never a token. Any same-origin script
// (XSS, malicious extension) could listen on BroadcastChannel and steal a token
// sent through it, so tokens stay out — each tab fetches its own via the HttpOnly
// refresh cookie.
type ChannelMsg = { type: 'refresh' } | { type: 'logout' };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [pendingMethods, setPendingMethods] = useState<string[]>([]);
  // H-1: BroadcastChannel for cross-tab login/logout coordination (signal only)
  const channelRef = useRef<BroadcastChannel | null>(null);
  const queryClient = useQueryClient();

  // FE-R2: End an expired session in-SPA. Clearing the user lets
  // ProtectedRoute/AdminRoute redirect to /login, replacing the per-request
  // `window.location.href = '/login'` hard reloads.
  useEffect(() => {
    setSessionExpiredHandler(() => setUser(null));
    return () => setSessionExpiredHandler(null);
  }, []);

  // Without a full page reload on session end, cached queries would survive
  // into the next session in this tab — drop them whenever nobody is signed in.
  useEffect(() => {
    if (!user) queryClient.clear();
  }, [user, queryClient]);

  const refreshUser = useCallback(async () => {
    try {
      const data = await authApi.me();
      setUser(data.user);
    } catch {
      setUser(null);
    }
  }, []);

  // On mount, try to restore session via HttpOnly refresh cookie (H4)
  useEffect(() => {
    // Open channel before init so we don't miss a sibling tab's token broadcast
    const channel =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('auth')
        : null;
    channelRef.current = channel;

    channel?.addEventListener('message', (e: MessageEvent<ChannelMsg>) => {
      if (e.data?.type === 'refresh') {
        // Another tab logged in — obtain our own token via the HttpOnly refresh
        // cookie instead of receiving one over the channel. Serialized across
        // tabs (Web Locks) so concurrent refreshes don't rotate each other out.
        refreshSession()
          .then((token) => {
            if (!token) return;
            setAccessToken(token);
            return authApi.me();
          })
          .then((d) => {
            if (d) setUser(d.user);
          })
          .catch(() => {});
      } else if (e.data?.type === 'logout') {
        // Another tab logged out — mirror the logout in this tab
        setAccessToken(null);
        setUser(null);
      }
    });

    const init = async () => {
      try {
        const token = await refreshSession();
        if (!token) return;
        setAccessToken(token);
        await refreshUser();
      } catch {
        // No valid session — user needs to log in
      } finally {
        setIsLoading(false);
      }
    };
    init();

    return () => {
      channel?.close();
      channelRef.current = null;
    };
  }, [refreshUser]);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const result = await authApi.login(email, password);
      if (result.accessToken && result.user) {
        setAccessToken(result.accessToken);
        // H4: refresh token is set as HttpOnly cookie by the server — no localStorage
        setUser(result.user);
        channelRef.current?.postMessage({
          type: 'refresh',
        } satisfies ChannelMsg);
      }
      return result;
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* ignore */
    }
    setAccessToken(null);
    // H4: server clears the HttpOnly cookie on logout
    setUser(null);
    channelRef.current?.postMessage({ type: 'logout' } satisfies ChannelMsg);
  }, []);

  const broadcastRefresh = useCallback(() => {
    channelRef.current?.postMessage({ type: 'refresh' } satisfies ChannelMsg);
  }, []);

  const setPendingState = useCallback((token: string, methods: string[]) => {
    setPendingToken(token);
    setPendingMethods(methods);
  }, []);

  const clearPendingState = useCallback(() => {
    setPendingToken(null);
    setPendingMethods([]);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        pendingToken,
        pendingMethods,
        login,
        logout,
        broadcastRefresh,
        setPendingState,
        clearPendingState,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
