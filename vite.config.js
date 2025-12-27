import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import path from 'node:path';

const SRC_DIR = path.resolve(__dirname, 'src');
const DIST_DIR = path.resolve(__dirname, 'dist', 'renderer');

export default defineConfig({
    root: SRC_DIR,
    base: './',
    plugins: [svgr(), react()],
    server: {
        host: '127.0.0.1',
        port: 5173,
        strictPort: true,
        hmr: {
            host: '127.0.0.1'
        }
    },
    build: {
        outDir: DIST_DIR,
        emptyOutDir: true,
        assetsDir: 'assets',
        rollupOptions: {
            input: path.resolve(SRC_DIR, 'index.html')
        }
    }
});
