import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
}));
