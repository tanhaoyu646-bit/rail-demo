import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const publicDemo = mode === 'demo';
  return {
    // Relative URLs work both at localhost and under /rail-demo/ on GitHub Pages.
    base: './',
    publicDir: publicDemo ? resolve(__dirname, 'working/public-demo') : resolve(__dirname, 'public'),
    define: {
      __PUBLIC_DEMO__: JSON.stringify(publicDemo),
    },
    resolve: {
      alias: publicDemo ? {
        './uploadedFpsHand': resolve(__dirname, 'src/uploadedFpsHand.demo.ts'),
      } : {},
    },
    build: {
      outDir: publicDemo ? 'dist-public' : 'dist',
      emptyOutDir: true,
      sourcemap: false,
      cssCodeSplit: true,
    },
  };
});
