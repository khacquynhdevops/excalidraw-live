import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies the socket and API to a canvas server on :3000.
export default defineConfig({
  plugins: [react()],
  // npm hoists a React 18 peer for @excalidraw/excalidraw; keep one React (19).
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:3000', ws: true }, '/api': 'http://127.0.0.1:3000' } }
});
