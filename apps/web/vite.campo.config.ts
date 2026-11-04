// App de campo (campo.html) como site próprio.
//   npx vite build --config vite.campo.config.ts --mode demo   → dist-campo/ com o simulador de API, para o GitHub Pages
//   npx vite --config vite.campo.config.ts --mode demo          → desenvolvimento do modo demonstração (abre /campo.html)
// VITE_BASE muda o subcaminho (padrão da demo: /irrivert-campo-demo/).
import react from '@vitejs/plugin-react';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** O Pages serve index.html: renomeia campo.html e cria .nojekyll. */
const paginaInicial = (outDir: string): Plugin => ({
  name: 'campo-index',
  apply: 'build',
  closeBundle() {
    const de = resolve(outDir, 'campo.html');
    if (existsSync(de)) renameSync(de, resolve(outDir, 'index.html'));
    writeFileSync(resolve(outDir, '.nojekyll'), '');
  },
});

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  const outDir = resolve(__dirname, 'dist-campo');
  return {
    plugins: [react(), paginaInicial(outDir)],
    base: process.env.VITE_BASE ?? (demo ? '/irrivert-campo-demo/' : '/'),
    define: demo ? { 'import.meta.env.VITE_DEMO': JSON.stringify('1') } : {},
    build: { outDir, emptyOutDir: true, rollupOptions: { input: resolve(__dirname, 'campo.html') } },
    server: { port: 5175, open: '/campo.html', proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:3000' } },
  };
});
