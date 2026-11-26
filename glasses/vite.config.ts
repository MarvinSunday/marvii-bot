import { defineConfig } from 'vite';

// Relative paths, so the build works both packed (.ehpk) and served by the bot server.
export default defineConfig({ base: './', build: { target: 'es2020' } });
