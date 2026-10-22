import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// The Tauri WebView loads the built bundle from dist-rust (see tauri.conf.json frontendDist).
// The dev server serves the fixture bridge (no native core) for browser development.
export default defineConfig({
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
    },
    build: {
        target: 'chrome120',
        outDir: 'dist',
        sourcemap: true,
        // The native core does all I/O; the renderer must not fetch anything at runtime.
        assetsInlineLimit: 0,
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
});