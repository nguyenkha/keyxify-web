import { defineConfig } from "vite";
import { execSync } from "child_process";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import { sentryVitePlugin } from "@sentry/vite-plugin";

function git(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf8" }).trim(); } catch { return ""; }
}

const gitHash = (process.env.VITE_GIT_HASH || git("git rev-parse --short=7 HEAD")).slice(0, 7);
const gitTag = process.env.VITE_GIT_TAG || git("git describe --tags --exact-match 2>/dev/null");

export default defineConfig({
  base: "/",
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __GIT_HASH__: JSON.stringify(gitHash),
    __GIT_TAG__: JSON.stringify(gitTag),
  },
  plugins: [
    react(),
    tailwindcss(),
    wasm(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT_FRONTEND,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: { name: process.env.VITE_GIT_HASH },
      sourcemaps: {
        filesToDeleteAfterUpload: ["./dist/**/*.map"],
      },
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  build: {
    sourcemap: true,
    rollupOptions: {
      external: [/^node:/, /^bun:/],
    },
  },
server: {
    allowedHosts: ["m4.kha.do"],
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
