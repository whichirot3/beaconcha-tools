import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AppCrashBoundary } from './components/AppCrashBoundary';
import { installGlobalUiErrorLogging, logUi } from './lib/logger';
import './styles/theme.css';
import './styles/app.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

installGlobalUiErrorLogging();
logUi('info', 'bootstrap', 'Desktop UI bootstrap initialized');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppCrashBoundary>
        <App />
      </AppCrashBoundary>
    </QueryClientProvider>
  </StrictMode>
);
