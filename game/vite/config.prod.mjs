import { defineConfig } from 'vite';

const BUILD = String(Date.now());
/** Screens compare this with their own build and reload themselves. */
const versionFile = () => ({
    name: 'version-file',
    generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) });
    },
});

export default defineConfig({
    base: './',
    define: { __BUILD__: JSON.stringify(BUILD) },
    logLevel: 'warning',
    build: {
        rollupOptions: {
            input: {
                main: 'index.html',
                admin: 'admin.html',
                rg: 'rg.html'
            },
            output: {
                manualChunks: {
                    phaser: ['phaser']
                }
            }
        },
        minify: 'terser',
        terserOptions: {
            compress: {
                passes: 2
            },
            mangle: true,
            format: {
                comments: false
            }
        }
    },
    server: {
        port: 8080
    },
    plugins: [
        versionFile()
    ]
});
