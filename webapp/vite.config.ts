/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [svelte()],
  test: {
    // Pure-logic seams only: no browser, no Web Bluetooth, no DOM.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
