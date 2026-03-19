import { test, expect } from "@playwright/test";

test.describe("Unauthenticated navigation", () => {
  test("visiting /accounts without auth token redirects to /login", async ({ page }) => {
    await page.goto("/accounts");
    await expect(page).toHaveURL(/\/login/);
  });

  test("visiting /config without auth token redirects to /login", async ({ page }) => {
    await page.goto("/config");
    await expect(page).toHaveURL(/\/login/);
  });

  test("visiting /login renders the login form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "kexify" })).toBeVisible();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
  });

  test("visiting /recovery renders the recovery import page", async ({ page }) => {
    await page.goto("/recovery");
    await expect(page.getByText("Wallet Recovery")).toBeVisible();
    await expect(page.getByText("Your key file")).toBeVisible();
  });
});
