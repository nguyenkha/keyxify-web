import { test, expect } from "./fixtures/auth";

// Helper: wait for config page to finish loading by waiting for "Expert mode" text
// The ConfigPage renders "Loading..." until its Promise.all resolves.
// We navigate fresh per test and wait for the resolved state.
async function gotoConfig(page: import("@playwright/test").Page) {
  await page.goto("/config");
  // Wait for the loaded state — "Expert mode" is always rendered after loading
  await expect(page.getByText("Expert mode")).toBeVisible({ timeout: 15_000 });
}

test.describe("Config page (authenticated)", () => {
  test("config page loads with main heading", async ({ authedPage }) => {
    await gotoConfig(authedPage);
    // The main content h2 (not the sidebar topbar heading which says "⚙️ Config")
    await expect(authedPage.getByRole("heading", { name: "Config", exact: true })).toBeVisible();
  });

  test("expert mode toggle is visible", async ({ authedPage }) => {
    await gotoConfig(authedPage);
    await expect(authedPage.getByText("Expert mode")).toBeVisible();
  });

  test("preferences section is visible", async ({ authedPage }) => {
    await gotoConfig(authedPage);
    // Section label "Preferences" — use exact match to avoid matching partial text
    await expect(authedPage.getByText("Preferences", { exact: true })).toBeVisible();
  });

  test("address book section is visible", async ({ authedPage }) => {
    await gotoConfig(authedPage);
    await expect(authedPage.getByText(/address book/i)).toBeVisible();
  });

  test("refresh interval options are visible", async ({ authedPage }) => {
    await gotoConfig(authedPage);
    await expect(authedPage.getByText("Refresh interval")).toBeVisible();
    await expect(authedPage.getByRole("button", { name: "30s" })).toBeVisible();
    await expect(authedPage.getByRole("button", { name: "1m" })).toBeVisible();
    await expect(authedPage.getByRole("button", { name: "5m" })).toBeVisible();
  });

  test("default chains section is visible", async ({ authedPage }) => {
    await gotoConfig(authedPage);
    await expect(authedPage.getByText("Default chains")).toBeVisible();
  });
});
