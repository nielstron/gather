import { normalizeBasePath } from './src/lib/base-path.js';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit({ adapter: adapter(), paths: { base: normalizeBasePath(process.env.GATHER_BASE_PATH) } })]
});
