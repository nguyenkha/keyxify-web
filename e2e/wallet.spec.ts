import { test, expect } from "./fixtures/auth";

test.describe("Wallet page (authenticated)", () => {
  test("shows empty state for new user", async ({ authedPage }) => {
    await authedPage.goto("/accounts");
    await expect(authedPage.getByText("Welcome to kexify")).toBeVisible();
    // Use the button in the empty state (not any dialog that may open)
    await expect(authedPage.getByRole("button", { name: "Create Your Wallet" })).toBeVisible();
  });

  test("shows how-it-works info cards for new user", async ({ authedPage }) => {
    await authedPage.goto("/accounts");
    await expect(authedPage.getByText("Secure key generation")).toBeVisible();
    await expect(authedPage.getByText("Passkey protection")).toBeVisible();
    await expect(authedPage.getByText("Built-in fraud protection")).toBeVisible();
  });

  test("sidebar navigation is visible after auth", async ({ authedPage }) => {
    await authedPage.goto("/accounts");
    // The sidebar renders the kexify brand heading
    await expect(authedPage.getByRole("heading", { name: "kexify" })).toBeVisible();
  });

  test("sidebar Advanced toggle and main nav are visible", async ({ authedPage }) => {
    await authedPage.goto("/accounts");
    // Main nav items are always visible
    await expect(authedPage.getByRole("button", { name: /Accounts/i })).toBeVisible();
    // Advanced section toggle is rendered in the sidebar
    await expect(authedPage.getByRole("button", { name: /advanced/i })).toBeVisible();
  });

  test("accounts page loads without error for new user", async ({ authedPage }) => {
    // For a brand-new user there are no keys, so the tab bar is hidden.
    // Just verify the page loads without error.
    await authedPage.goto("/accounts");
    await expect(authedPage.getByText("Welcome to kexify")).toBeVisible();
  });

  test("unauthenticated visit after token clear redirects to login", async ({ authedPage }) => {
    await authedPage.goto("/accounts");
    // Clear the token
    await authedPage.evaluate(() => {
      sessionStorage.removeItem("secretkey_token");
      localStorage.removeItem("secretkey_refresh_token");
    });
    await authedPage.goto("/accounts");
    await expect(authedPage).toHaveURL(/\/login/);
  });
});
