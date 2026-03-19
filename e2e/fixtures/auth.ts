import { test as base, type Page } from "@playwright/test";

type AuthFixtures = {
  authedPage: Page;
};

const BACKEND = "http://localhost:3000";
// Production API base that may be set in .env.local — intercept and proxy to local backend
const PROD_API_PATTERN = /^https:\/\/api\.[^/]+\//;

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ page, request }, use) => {
    const uuid = crypto.randomUUID().slice(0, 8);
    const res = await request.post(`${BACKEND}/test/login`, {
      data: { email: `e2e-${uuid}@test.local` },
    });

    if (!res.ok()) {
      throw new Error(`Test login failed: ${res.status()} ${await res.text()}`);
    }

    const { token } = await res.json();

    // Intercept any requests going to production API (when VITE_API_URL is set)
    // and proxy them to the local backend instead.
    await page.route(PROD_API_PATTERN, async (route) => {
      const original = route.request().url();
      // Strip the production origin, keep the path (e.g. https://api.kexify.xyz/chains → /chains)
      const url = new URL(original);
      const localUrl = `${BACKEND}${url.pathname}${url.search}`;
      const method = route.request().method();
      const headers = route.request().headers();
      const postData = route.request().postDataBuffer();

      try {
        const fetchRes = await fetch(localUrl, {
          method,
          headers: { ...headers, host: "localhost:3000" },
          body: postData ?? undefined,
        });
        const body = await fetchRes.arrayBuffer();
        const responseHeaders: Record<string, string> = {};
        fetchRes.headers.forEach((v, k) => { responseHeaders[k] = v; });
        await route.fulfill({
          status: fetchRes.status,
          headers: responseHeaders,
          body: Buffer.from(body),
        });
      } catch {
        await route.abort();
      }
    });

    await page.goto("/login");
    await page.evaluate((t) => localStorage.setItem("secretkey_token", t), token);
    await use(page);
  },
});

export { expect } from "@playwright/test";
