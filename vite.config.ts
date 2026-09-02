import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const publicDemo = mode === 'demo';
  const publicHosted = mode === 'hosted';
  return {
    // Relative URLs work both at localhost and under /rail-demo/ on GitHub Pages.
    base: './',
    publicDir: publicDemo ? resolve(__dirname, 'working/public-demo') : resolve(__dirname, 'public'),
    define: {
      __PUBLIC_DEMO__: JSON.stringify(publicDemo),
      __PUBLIC_HOSTED__: JSON.stringify(publicDemo || publicHosted),
    },
    resolve: {
      alias: publicDemo ? {
        './uploadedFpsHand': resolve(__dirname, 'src/uploadedFpsHand.demo.ts'),
        './uploadedPhotoHand': resolve(__dirname, 'src/uploadedPhotoHand.demo.ts'),
      } : {},
    },
    build: {
      outDir: publicDemo ? 'dist-public' : publicHosted ? 'dist-hosted' : 'dist',
      emptyOutDir: true,
      sourcemap: false,
      cssCodeSplit: true,
    },
  };
});
