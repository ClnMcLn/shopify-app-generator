import { chromium } from "playwright";

const dashboardUrl = process.env.SHOPIFY_DEV_DASHBOARD_URL;
const email = process.env.SHOPIFY_EMAIL;
const password = process.env.SHOPIFY_PASSWORD;

export async function saveShopifyStorageState() {
  const browser = await chromium.launch({ headless: false }); // headed so you can do MFA
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });

  // Attempt common login selectors; if Shopify changes, you can just complete login manually in the window.
  const emailSelector = 'input[type="email"], input[name="account[email]"], input#account_email';
  const passSelector = 'input[type="password"], input[name="account[password]"], input#account_password';

  if (await page.locator(emailSelector).first().isVisible().catch(() => false)) {
    await page.locator(emailSelector).first().fill(email);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
  }

  if (await page.locator(passSelector).first().isVisible().catch(() => false)) {
    await page.locator(passSelector).first().fill(password);
    await page.keyboard.press("Enter");
  }

  // Give you time to finish MFA / “Continue” prompts manually if needed.
  // When you see the dev dashboard/apps page, come back here and press Enter in Terminal.
  console.log("\nComplete login in the opened browser (including MFA), then press Enter here...");
  await new Promise((resolve) => process.stdin.once("data", resolve));

  await context.storageState({ path: "storage/shopify-storage.json" });
  await browser.close();

  console.log("Saved storage state to storage/shopify-storage.json");
}
