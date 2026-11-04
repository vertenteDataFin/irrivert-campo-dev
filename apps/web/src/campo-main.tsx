// Entrada do app de campo (campo.html). Com VITE_DEMO=1 liga o simulador de API antes de montar a tela.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AppCampo from './AppCampo';
import { instalarDemo } from './demo';
import './index.css';

if (import.meta.env.VITE_DEMO === '1') instalarDemo();

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <AppCampo />
    </QueryClientProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw-campo.js`).catch(() => { /* sem service worker: segue online */ }); });
}
