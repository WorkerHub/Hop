import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import App from './App.tsx';
import { isRetryableError } from './api/client.ts';
import { AppConfigProvider } from './contexts/AppConfigContext.tsx';
import { AuthProvider } from './contexts/AuthContext.tsx';
import { ThemeProvider } from './contexts/ThemeContext.tsx';
import { I18nProvider } from './i18n/index.tsx';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // FE-R4: one retry, and only when it can plausibly help — transport
      // failures and 5xx. A 4xx (bad request, not found, session expired) is a
      // final answer, so retrying it only delays the error.
      retry: (failureCount, error) =>
        failureCount < 1 && isRetryableError(error),
      staleTime: 30_000,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Failed to find the root element');
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <BrowserRouter>
          <QueryClientProvider client={queryClient}>
            <AppConfigProvider>
              <AuthProvider>
                <App />
                <Toaster richColors position="top-right" />
              </AuthProvider>
            </AppConfigProvider>
          </QueryClientProvider>
        </BrowserRouter>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
