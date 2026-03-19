import { test, expect } from "@playwright/test";

test.describe("Login page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("renders kexify branding, email input, and send magic link button", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "kexify" })).toBeVisible();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(page.getByRole("button", { name: /Send Magic Link/i })).toBeVisible();
  });

  test("email input accepts typed text", async ({ page }) => {
    const input = page.getByPlaceholder("you@example.com");
    await input.fill("test@example.com");
    await expect(input).toHaveValue("test@example.com");
  });

  test("Recovery Mode link exists and points to /recovery", async ({ page }) => {
    const link = page.getByRole("link", { name: "Recovery Mode" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/recovery");
  });

  test("theme toggle button changes data-theme on html element", async ({ page }) => {
    // The toggle button has a title describing what it switches to
    const toggle = page.getByRole("button", { name: /switch to (light|dark) mode/i });
    await expect(toggle).toBeVisible();

    const html = page.locator("html");
    const before = await html.getAttribute("data-theme");

    await toggle.click();

    const after = await html.getAttribute("data-theme");
    expect(after).not.toBe(before);
  });
});
