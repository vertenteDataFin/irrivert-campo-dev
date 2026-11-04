import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // API_URL permite apontar para outra porta em desenvolvimento (ex.: 3010 com o banco local).
  // 127.0.0.1 em vez de localhost: no Node 24 "localhost" pode resolver para ::1, onde a API não escuta.
  server: { port: 5173, proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:3000' } },
});
