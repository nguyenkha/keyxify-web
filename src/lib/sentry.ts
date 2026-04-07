import * as Sentry from "@sentry/react";

const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined) || undefined;
const release = (import.meta.env.VITE_GIT_TAG as string | undefined) || (import.meta.env.VITE_GIT_HASH as string | undefined) || "dev";

export function initSentry() {
  if (!dsn) return;

  Sentry.init({
    dsn,
    release,
    environment: import.meta.env.MODE,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration(),
    ],
    tracesSampleRate: 0.2,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
  });
}
