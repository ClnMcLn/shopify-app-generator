// src/lib/generateShopifyApp.js
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * End-to-end Shopify Dev Dashboard -> create app -> configure version
 * -> release -> scrape client id/secret -> (attempt) generate custom distribution install link.
 *
 * IMPORTANT FINDING:
 * - Partners distribution step may redirect to Shopify Accounts login (accounts.shopify.com)
 *   and can require 2FA / Cloudflare verification.
 * - That flow cannot be completed in headless Render/Docker.
 * - We detect it, screenshot it, and fail with a clear error so callers know what happened.
 *
 * Expects env vars:
 * - SHOPIFY_DEV_DASHBOARD_URL
 * - SHOPIFY_PARTNERS_ID (optional; default 2767396)
 * - APP_URL
 * - REDIRECT_URL
 * - SCOPES_CSV
 * - PW_HEADED=1 (optional; headed mode for debugging locally)
 *
 * Uses storageState:
 * - storage/shopify-storage.json
 */

// -------- storage / screenshots --------
const STORAGE_DIR =
  process.env.STORAGE_DIR ||
  (process.env.RENDER
    ? "/app/storage"
    : path.join(process.cwd(), "storage"));

async function ensureStorageDir() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

function storagePath(filename) {
  return path.join(STORAGE_DIR, filename);
}

function screenshotsEnabled() {
  const v = String(process.env.ENABLE_SCREENSHOTS || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function safeScreenshot(page, filename) {
  // Fast no-op unless explicitly enabled
  if (!screenshotsEnabled()) return;

  try {
    await ensureStorageDir();
    const full = storagePath(filename.replace(/^storage\//, ""));
    await page.screenshot({ path: full, fullPage: true });
    console.log("Saved screenshot:", full);
  } catch (e) {
    console.log("Screenshot failed:", e?.message || e);
  }
}


// -------- misc helpers --------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function extractAppId(url) {
  const m = String(url || "").match(/\/apps\/(\d+)(?:\/|$)/);
  return m ? m[1] : null;
}

function dashboardIdFromUrl(dashboardUrl) {
  const m = String(dashboardUrl || "").match(/\/dashboard\/(\d+)\b/);
  return m ? m[1] : null;
}

function domainInputLocator(page) {
  // Prefer label-based selection first (most stable)
  const byLabel = page
    .getByRole("textbox", { name: /shopify domain|store domain|store url|domain/i })
    .first();

  // Polaris inputs often have ids like #PolarisTextField1, #PolarisTextField2, etc
  const polarisId = page.locator('input[id^="PolarisTextField"], textarea[id^="PolarisTextField"]').first();

  // Fallback: placeholder-based
  const byPlaceholder = page
    .locator('input[placeholder*="myshopify" i], input[placeholder*="myshopify.com" i]')
    .first();

  // Fallback: any input that looks like a domain entry near relevant text
  const nearText = page
    .locator('input')
    .filter({ has: page.locator(':text("myshopify")') })
    .first();

  // Return a locator that matches *any* of these
  return byLabel.or(polarisId).or(byPlaceholder).or(nearText);
}

// Detect the Shopify Accounts / 2FA wall (login page or account select)
async function assertNotBlockedBy2FA(page, labelForLogs = "page") {
  const url = page.url();

  const isAccounts =
    url.includes("accounts.shopify.com/select") ||
    url.includes("accounts.shopify.com/lookup") ||
    url.includes("accounts.shopify.com/login") ||
    url.includes("accounts.shopify.com");

  if (!isAccounts) return;

  // Try to confirm it’s the login UI (best-effort)
  const looksLikeLoginUi =
    (await page.getByRole("heading", { name: /log in/i }).count().catch(() => 0)) > 0 ||
    (await page.getByRole("button", { name: /continue with email/i }).count().catch(() => 0)) > 0 ||
    (await page.getByText(/continue to shopify account/i).count().catch(() => 0)) > 0;

  await safeScreenshot(page, `blocked-${labelForLogs}.png`);

  throw new Error(
    [
      `Blocked by Shopify Accounts login / 2FA at ${labelForLogs}.`,
      `Current URL: ${url}`,
      looksLikeLoginUi
        ? `Detected Shopify login UI (2FA likely required).`
        : `Detected accounts.shopify.com redirect (auth required).`,
      ``,
      `This cannot be completed in headless Render/Docker.`,
      `Run locally with PW_HEADED=1, complete login/2FA, then export a fresh storageState that includes Partners access.`,
    ].join("\n")
  );
}

// -------- scraping helpers --------
async function scrapeClientIdAndSecret(settingsPage) {
  const idCandidates = [
    settingsPage.locator('input[id*="client_id" i]').first(),
    settingsPage.locator('input[name*="client_id" i]').first(),
    settingsPage.locator('input:near(:text("Client ID"))').first(),
    settingsPage.locator('code:near(:text("Client ID"))').first(),
  ];

  let clientId = "";
  for (const c of idCandidates) {
    try {
      if ((await c.count()) === 0) continue;
      const tag = (await c.evaluate((el) => el.tagName)).toLowerCase();
      clientId = tag === "code" ? clean(await c.textContent()) : clean(await c.inputValue());
      if (clientId) break;
    } catch {}
  }

  // Reveal secret if needed
  const reveal = settingsPage.getByRole("button", { name: /reveal/i }).first();
  if ((await reveal.count()) > 0) {
    try {
      await reveal.click({ force: true });
      await sleep(500);
    } catch {}
  }

  const secretCandidates = [
    settingsPage.locator('input[id*="client_secret" i]').first(),
    settingsPage.locator('input[name*="client_secret" i]').first(),
    settingsPage.locator('input:near(:text("Client secret"))').first(),
    settingsPage.locator('code:near(:text("Client secret"))').first(),
  ];

  let clientSecret = "";
  for (const c of secretCandidates) {
    try {
      if ((await c.count()) === 0) continue;
      const tag = (await c.evaluate((el) => el.tagName)).toLowerCase();
      clientSecret = tag === "code" ? clean(await c.textContent()) : clean(await c.inputValue());
      if (clientSecret) break;
    } catch {}
  }

  console.log("SCRAPED clientId length:", (clientId || "").length);
  console.log("SCRAPED clientSecret length:", (clientSecret || "").length);
  return { clientId, clientSecret };
}

async function configureVersionAndRelease(page, { appId, dashboardId }) {
  const appUrl = process.env.APP_URL;
  const redirectUrl = process.env.REDIRECT_URL;
  const scopesCsv = process.env.SCOPES_CSV;

  if (!appUrl) throw new Error("Missing env var: APP_URL");
  if (!redirectUrl) throw new Error("Missing env var: REDIRECT_URL");
  if (!scopesCsv) throw new Error("Missing env var: SCOPES_CSV");
  if (!dashboardId) throw new Error("Could not parse dashboard id from SHOPIFY_DEV_DASHBOARD_URL");

  const versionsNewUrl = `https://dev.shopify.com/dashboard/${dashboardId}/apps/${appId}/versions/new`;
  await page.goto(versionsNewUrl, { waitUntil: "domcontentloaded" });
  console.log("Versions/new URL:", page.url());
  await sleep(1200);

  // App URL
  const appUrlInput = page.locator("#version_app_module_data_app_home_app_url");
  await appUrlInput.waitFor({ state: "visible", timeout: 30_000 });
  await appUrlInput.scrollIntoViewIfNeeded();
  await appUrlInput.click({ force: true });
  await appUrlInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await appUrlInput.type(appUrl, { delay: 10 });
  await appUrlInput.press("Tab");

  const appUrlReadback = (await appUrlInput.inputValue()).trim();
  console.log("READBACK App URL:", appUrlReadback);
  if (appUrlReadback !== appUrl) {
    await safeScreenshot(page, "app-url-did-not-stick.png");
    throw new Error(`App URL did not stick. Expected "${appUrl}", got "${appUrlReadback}"`);
  }

  // Embed checkbox
  const embedCheckbox = page.getByRole("checkbox", { name: /embed app in shopify admin/i });
  if ((await embedCheckbox.count()) === 0) {
    await safeScreenshot(page, "embed-checkbox-not-found.png");
    throw new Error('Could not find "Embed app in Shopify admin" checkbox');
  }

  // Your prior behavior: uncheck if checked
  const checked = await embedCheckbox.isChecked();
  console.log("Embed checked before:", checked);
  if (checked) {
    await embedCheckbox.click({ force: true });
    await sleep(300);
  }
  console.log("Embed checked after:", await embedCheckbox.isChecked());

  await safeScreenshot(page, "before-release-after-url-embed.png");

  // Scopes
  const scopesField = page.locator("#version_app_module_data_app_access_app_scopes");
  await scopesField.waitFor({ timeout: 30_000 });
  await scopesField.scrollIntoViewIfNeeded();
  await scopesField.click({ force: true });
  await scopesField.fill(scopesCsv);
  await scopesField.blur();

  const scopesRb = (await scopesField.inputValue().catch(() => "")).trim();
  console.log("Filled: Scopes");
  console.log("Scopes readback length:", scopesRb.length);

  // Redirect URLs (best-effort selector)
  const redirectField = page
    .locator(
      [
        'textarea[id*="redirect" i]',
        'textarea[name*="redirect" i]',
        'input[id*="redirect" i]',
        'input[name*="redirect" i]',
      ].join(",")
    )
    .filter({ hasNot: page.locator("#version_app_module_data_app_access_app_optional_scopes") })
    .first();

  await redirectField.waitFor({ timeout: 30_000 });
  await redirectField.scrollIntoViewIfNeeded();
  await redirectField.click({ force: true });
  await redirectField.fill(redirectUrl);
  await redirectField.blur();

  const redirectRb = (await redirectField.inputValue().catch(() => "")).trim();
  console.log("Redirect readback:", redirectRb);

  // Release
  await page.waitForTimeout(500);
  const releaseBtn = page.getByRole("button", { name: /^release$/i }).first();
  await releaseBtn.waitFor({ state: "visible", timeout: 30_000 });

  const disabled = await releaseBtn.isDisabled().catch(() => true);
  console.log("Release visible. Disabled?", disabled);
  await safeScreenshot(page, "before-release.png");

  if (disabled) {
    await safeScreenshot(page, "release-disabled.png");
    throw new Error('Release button is disabled (fields likely not valid / not saved).');
  }

  await releaseBtn.click({ force: true });
  console.log('Clicked: "Release"');
  await page.waitForTimeout(800);

  // Confirm release (modal or secondary button)
  const confirmReleaseBtn = page
    .getByRole("button", { name: /^release$/i })
    .filter({ hasNotText: /create an app/i })
    .last();

  if ((await confirmReleaseBtn.count()) > 0) {
    await confirmReleaseBtn.waitFor({ state: "visible", timeout: 30_000 });
    await confirmReleaseBtn.click({ force: true });
    console.log('Clicked: Confirm "Release"');
  }

  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);

  // Verify on current page (don’t depend on Versions list UI)
  const vAppUrl = (await page.locator("#version_app_module_data_app_home_app_url").inputValue().catch(() => "")).trim();
  const vScopes = (await page.locator("#version_app_module_data_app_access_app_scopes").inputValue().catch(() => "")).trim();

  console.log("VERIFY (current page) app url:", vAppUrl);
  console.log("VERIFY (current page) scopes len:", vScopes.length);
  await safeScreenshot(page, "verify-current-version.png");
}

// Distribution link generation is best-effort: it will not run if 2FA blocks access.
async function selectCustomDistribution(distPage) {
  const u = distPage.url();
  console.log("selectCustomDistribution() URL:", u);
  await safeScreenshot(distPage, "storage/distribution-selectCustom-start.png");

  // Must be on partners distribution page
  if (!u.includes("partners.shopify.com") || !u.includes("/distribution")) {
    await safeScreenshot(distPage, "storage/not-on-distribution.png");
    throw new Error(`Not on partners distribution page. URL: ${u}`);
  }

// 1) Wait for ANY anchor that indicates the distribution UI is present
await Promise.race([
  distPage.getByText(/distribution/i).first().waitFor({ state: "visible", timeout: 90_000 }),
  distPage.getByText(/custom distribution/i).first().waitFor({ state: "visible", timeout: 90_000 }),
  distPage.getByText(/select custom distribution/i).first().waitFor({ state: "visible", timeout: 90_000 }),
  distPage.getByText(/generate link/i).first().waitFor({ state: "visible", timeout: 90_000 }),
  distPage.locator("#PolarisTextField1").first().waitFor({ state: "visible", timeout: 90_000 }),
  distPage.locator('button:has-text("Select")').first().waitFor({ state: "visible", timeout: 90_000 }),
  distPage.locator('button:has-text("Continue")').first().waitFor({ state: "visible", timeout: 90_000 }),
]);
  await safeScreenshot(distPage, "storage/distribution-ui-anchor-visible.png");

  // 2) If we already see the domain field / generate link, custom distribution is already selected
  const domainField = domainInputLocator(distPage);
  const genBtn = distPage.locator('button:has-text("Generate link"), button:has-text("Generate")');

  if ((await domainField.count()) > 0 || (await genBtn.count()) > 0) {
    console.log("Custom distribution appears already selected (domain/generate UI present).");
    return;
  }

  // 3) Path A: direct "Select custom distribution" button exists
  const direct = distPage.locator('button:has-text("Select custom distribution"), a:has-text("Select custom distribution")').first();
  if ((await direct.count()) > 0) {
    await direct.waitFor({ state: "visible", timeout: 60_000 });
    await direct.click({ force: true });
    console.log('Clicked: "Select custom distribution" (direct button)');
    await distPage.waitForTimeout(1500);
    await safeScreenshot(distPage, "storage/distribution-after-direct-select.png");
  } else {
    // 4) Path B: click the “Custom distribution” card/row/text
    const customText = distPage.locator("text=/custom distribution/i").first();
    if ((await customText.count()) > 0) {
      await customText.waitFor({ state: "visible", timeout: 60_000 });
      await customText.click({ force: true });
      console.log('Clicked: "Custom distribution" (card/text)');
      await distPage.waitForTimeout(800);
      await safeScreenshot(distPage, "storage/distribution-after-custom-card-click.png");
    }

    // 5) Path C: there is usually a generic Select / Continue / Next after choosing the method
    const nextBtn = distPage
      .locator('button:has-text("Select"), button:has-text("Continue"), button:has-text("Next"), a:has-text("Select")')
      .filter({ hasNotText: /select custom distribution/i })
      .first();

    if ((await nextBtn.count()) > 0) {
      await nextBtn.waitFor({ state: "visible", timeout: 60_000 });
      await nextBtn.click({ force: true });
      console.log('Clicked: "Select/Continue/Next" after choosing method');
      await distPage.waitForTimeout(1500);
      await safeScreenshot(distPage, "storage/distribution-after-generic-select.png");
    }
  }

  // Handle possible confirmation modal (Select / Confirm / Continue)
  const modal = distPage.locator('[role="dialog"], .Polaris-Modal-Dialog, .Polaris-Modal').first();
  if ((await modal.count()) > 0) {
    const confirm = modal
      .locator('button:has-text("Select"), button:has-text("Confirm"), button:has-text("Continue")')
      .first();

    if ((await confirm.count()) > 0) {
      await confirm.click({ force: true });
      console.log("Confirmed selection in modal");
      await distPage.waitForTimeout(1500);
      await safeScreenshot(distPage, "storage/distribution-after-confirm-modal.png");
    }
  }

  // Final assert: domain input must now exist
  const finalDomain = domainInputLocator(distPage);
  try {
    await finalDomain.first().waitFor({ state: "visible", timeout: 60_000 });
  } catch {
    await safeScreenshot(distPage, "storage/custom-distribution-form-not-found.png");
    throw new Error(
      `Custom distribution form still not visible (no domain input). URL: ${distPage.url()}`
    );
  }

  console.log("Custom distribution form detected (domain input present).");
  await safeScreenshot(distPage, "storage/custom-distribution-form-visible.png");
}

async function fillDomainAndGenerateLink(distPage, store_domain) {
// Must be on partners distribution page
if (!distPage.url().includes("/distribution")) {
  await safeScreenshot(distPage, "storage/not-on-distribution.png");
  throw new Error(`Not on partners distribution page. URL: ${distPage.url()}`);
}

// Give the page a moment to render
await distPage.waitForLoadState("domcontentloaded").catch(() => {});
await distPage.waitForTimeout(1000);

// Domain input selector (Shopify UI changes a lot) — try multiple strategies
const domainCandidates = [
  // Best: label-based (works if Shopify exposes it accessibly)
  distPage.getByLabel(/shopify domain|store domain|domain/i).first(),

  // Placeholder-based (common for myshopify.com inputs)
  distPage.locator('input[placeholder*="myshopify" i], input[placeholder*="myshopify.com" i]').first(),

  // Fallback: first visible text input in main content
  distPage.locator('main input[type="text"], main input:not([type])').first(),
];

let domainInput = null;
for (const cand of domainCandidates) {
  try {
    if ((await cand.count()) > 0) {
      domainInput = cand;
      break;
    }
  } catch {}
}

if (!domainInput) {
  await safeScreenshot(distPage, "storage/domain-input-not-found.png");
  throw new Error(`Could not find domain input on distribution page. URL: ${distPage.url()}`);
}

await domainInput.waitFor({ state: "visible", timeout: 60_000 });

  await domainInput.scrollIntoViewIfNeeded();
  await domainInput.click({ force: true });
  await domainInput.fill("");
  await domainInput.type(store_domain, { delay: 25 });

  const typed = await domainInput.inputValue().catch(() => "");
  console.log("Domain typed value:", typed);

  if (typed.trim() !== store_domain) {
    await safeScreenshot(distPage, "domain-did-not-stick.png");
    throw new Error(`Domain did not stick. Expected "${store_domain}", got "${typed}"`);
  }

  const genBtn = distPage.locator('button:has-text("Generate link"), button:has-text("Generate")').first();
  await genBtn.waitFor({ timeout: 30_000 });
  await genBtn.click({ force: true });
  console.log('Clicked: "Generate link" (first)');
  await sleep(800);

  const modal = distPage.locator('[role="dialog"], .Polaris-Modal-Dialog, .Polaris-Modal').first();
  if ((await modal.count()) > 0) {
    const modalGen = modal.locator('button:has-text("Generate link"), button:has-text("Generate")').first();
    await modalGen.waitFor({ timeout: 30_000 });
    await modalGen.click({ force: true });
    console.log('Clicked: "Generate link" (modal confirm)');
    await sleep(1200);
  }

  await safeScreenshot(distPage, "distribution-after-generate.png");
  await sleep(900);

  // Scrape install link
  let link = "";
  try {
    link = (await distPage.getByRole("textbox", { name: /install link/i }).inputValue()).trim();
  } catch {}

  if (!link) {
    const inputs = distPage.locator("input");
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const v = (await inputs.nth(i).inputValue().catch(() => "")).trim();
      if (v.includes("admin.shopify.com") && (v.includes("/oauth/") || v.includes("install_custom_app"))) {
        link = v;
        break;
      }
    }
  }

  console.log("SCRAPED distributionLink length:", (link || "").length);
  return link;
}

export async function generateShopifyApp({ brand_name, store_domain }) {
  const dashboardUrl = process.env.SHOPIFY_DEV_DASHBOARD_URL;
  const partnersId = process.env.SHOPIFY_PARTNERS_ID || "2767396";

  if (!dashboardUrl) throw new Error("Missing env var: SHOPIFY_DEV_DASHBOARD_URL");
  if (!brand_name || typeof brand_name !== "string") throw new Error("brand_name is required");
  if (!store_domain || typeof store_domain !== "string") throw new Error("store_domain is required");

  const dashboardId = dashboardIdFromUrl(dashboardUrl);
  const appName = `${brand_name} x Retention`;

  const browser = await chromium.launch({
    headless: process.env.PW_HEADED !== "1",
    slowMo: process.env.PW_HEADED === "1" ? 150 : 0,
    args: process.env.RENDER ? ["--no-sandbox", "--disable-dev-shm-usage"] : undefined,
  });


function getStorageStatePath() {
  const json = process.env.SHOPIFY_STORAGE_STATE_JSON?.trim();
  if (!json) return "storage/shopify-storage.json"; // local dev fallback

  const p = path.join(os.tmpdir(), "shopify-storage.json");
  fs.writeFileSync(p, json, "utf8");
  return p;
}

const context = await browser.newContext({
  storageState: getStorageStatePath(),
});

  const page = await context.newPage();

  try {
    // 1) Apps list
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
    console.log("URL now:", page.url());

    // 2) Click "Create app"
    const createApp = page.locator('text=/Create\\s+app/i').first();
    await createApp.waitFor({ timeout: 60_000 });
    await createApp.click({ force: true });
    console.log("Clicked: Create app");

    await page.waitForURL(/\/apps\/new\b/, { timeout: 60_000 });
    console.log("After clicking Create app, URL:", page.url());

    // 3) Fill name
    const nameInput = page.locator("#app_form_name").first();
    await nameInput.waitFor({ timeout: 60_000 });
    await nameInput.click({ force: true });
    await nameInput.fill("");
    await nameInput.type(appName, { delay: 20 });

// 4) Submit create form (Shopify UI changes often — try a few options)
let submitCreate = null;

for (const cand of submitCreateCandidates) {
  try {
    if ((await cand.count()) === 0) continue;
    await cand.waitFor({ state: "visible", timeout: 15_000 });
    const disabled = await cand.isDisabled().catch(() => false);
    if (disabled) continue;
    submitCreate = cand;
    break;
  } catch {}
}

if (!submitCreate) {
  throw new Error(`Could not find a visible/enabled Create submit button on: ${page.url()}`);
}

await submitCreate.scrollIntoViewIfNeeded();
await submitCreate.click({ force: true });
console.log('Clicked: Submit "Create"');



    // 5) Created app detail URL
    await page.waitForURL(/\/apps\/\d+/, { timeout: 120_000 });
    console.log("Created app detail URL:", page.url());

    const appId = extractAppId(page.url());
    if (!appId) {
      await safeScreenshot(page, "create-app-no-appid.png");
      throw new Error(`Create succeeded but couldn't parse appId from URL: ${page.url()}`);
    }

    // 6) Configure version fields + Release
    await configureVersionAndRelease(page, { appId, dashboardId });

    // 7) Settings: scrape Client ID/Secret
    const settingsUrl = `https://dev.shopify.com/dashboard/${dashboardId}/apps/${appId}/settings`;
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await sleep(1200);
    console.log("Settings page URL:", page.url());
    await safeScreenshot(page, "app-settings.png");

    const { clientId, clientSecret } = await scrapeClientIdAndSecret(page);

    // 8) Distribution (Partners) — THIS IS WHERE 2FA BLOCKS IN HEADLESS
    const distributionUrl = `https://partners.shopify.com/${partnersId}/apps/${appId}/distribution`;
    console.log("Distribution page URL:", distributionUrl);

const distPage = await context.newPage();
await distPage.goto(distributionUrl, { waitUntil: "domcontentloaded" });
console.log("Distribution page ACTUAL URL:", distPage.url());

// If Shopify sends us to accounts.shopify.com, it’s a login/2FA wall.
// - On Render/headless: fail fast (can't complete 2FA)
// - Locally with PW_HEADED=1: let you complete it manually, then continue and save storageState
if (distPage.url().includes("accounts.shopify.com")) {
  if (process.env.PW_HEADED === "1") {
    console.log("2FA/login detected on Shopify Accounts. Complete it in the browser window now...");

    // Wait up to 10 minutes for you to finish 2FA and be redirected back to Partners.
    const start = Date.now();
    while (Date.now() - start < 10 * 60_000) {
      if (distPage.url().includes("partners.shopify.com")) break;
      await distPage.waitForTimeout(1000);
    }

    if (!distPage.url().includes("partners.shopify.com")) {
      await safeScreenshot(distPage, "storage/still-blocked-by-2fa.png");
      throw new Error(`Still blocked by Shopify Accounts after waiting. URL: ${distPage.url()}`);
    }

    console.log("Back on partners after 2FA:", distPage.url());

    // Save fresh storageState that includes Partners access
// Save fresh storageState that includes Partners access
const statePath = getStorageStatePath();
await context.storageState({ path: statePath });
console.log("Saved updated storageState with Partners auth at:", statePath);
  } else {
    await assertNotBlockedBy2FA(distPage, "partners-distribution");
  }
}

await safeScreenshot(distPage, "storage/distribution-before.png");

// 9) Select custom distribution
await selectCustomDistribution(distPage);

    console.log("After selecting custom distribution, URL:", distPage.url());
    await safeScreenshot(distPage, "distribution-after-select.png");

    const distributionLink = await fillDomainAndGenerateLink(distPage, store_domain);
    await safeScreenshot(distPage, "distribution-final.png");

    return {
      app_name: appName,
      client_id: clean(clientId),
      client_secret: clean(clientSecret),
      distribution_link: clean(distributionLink),
      note:
        "Created app + configured version + released + scraped Client ID/secret + generated distribution link (if not blocked by 2FA).",
      store_domain,
    };
  } finally {
    await browser.close();
  }
}