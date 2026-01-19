// src/lib/generateShopifyApp.js
import { chromium } from "playwright";

/**
 * End-to-end Shopify Dev Dashboard -> create app -> configure version
 * -> release -> scrape client id/secret -> generate custom distribution install link.
 *
 * Expects these env vars:
 * - SHOPIFY_DEV_DASHBOARD_URL (e.g. https://dev.shopify.com/dashboard/130027305/apps)
 * - SHOPIFY_PARTNERS_ID (e.g. 2767396) [optional; default 2767396]
 * - APP_URL (e.g. https://app.retention.com/integrations/oauth2/ShopifyOauth/start)
 * - REDIRECT_URL (e.g. https://app.retention.com/integrations/oauth2/ShopifyOauth)
 * - SCOPES_CSV (comma-separated scopes)
 * - PW_HEADED=1 (optional; headed mode for debugging)  [NOTE: on Render keep headless]
 *
 * Also uses storageState:
 * - storage/shopify-storage.json (must exist and be valid logged-in state)
 */

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

function baseDevUrl(href) {
  if (!href) return href;
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("/")) return `https://dev.shopify.com${href}`;
  return `https://dev.shopify.com/${href}`;
}

function dashboardIdFromUrl(dashboardUrl) {
  // dashboardUrl like: https://dev.shopify.com/dashboard/130027305/apps
  const m = String(dashboardUrl || "").match(/\/dashboard\/(\d+)\b/);
  return m ? m[1] : null;
}

async function safeScreenshot(page, path) {
  try {
    await page.screenshot({ path, fullPage: true });
  } catch {}
}

async function waitForAnyURL(page, patterns, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const u = page.url();
    if (
      patterns.some((p) =>
        p instanceof RegExp ? p.test(u) : String(u).includes(String(p))
      )
    ) {
      return u;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for URL to match any: ${patterns
      .map(String)
      .join(", ")}. Current: ${page.url()}`
  );
}

async function pickAccountIfNeeded(page) {
  // Shopify sometimes bounces to an account chooser
  const url = page.url();
  if (!url.includes("accounts.shopify.com/select")) return;

  console.log("On account chooser. Selecting account tile...");
  const tile = page
    .getByRole("link", { name: /Client Success|clientsuccess@retention\.com/i })
    .first();

  try {
    await tile.waitFor({ timeout: 30_000 });
    await tile.click({ force: true });
    return;
  } catch {}

  // Fallback: click first visible link tile
  const firstTile = page.getByRole("link").first();
  await firstTile.waitFor({ timeout: 30_000 });
  await firstTile.click({ force: true });
}

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
      clientId =
        tag === "code" ? clean(await c.textContent()) : clean(await c.inputValue());
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
      clientSecret =
        tag === "code" ? clean(await c.textContent()) : clean(await c.inputValue());
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
  if (!dashboardId)
    throw new Error("Could not parse dashboard id from SHOPIFY_DEV_DASHBOARD_URL");

  const versionsNewUrl = `https://dev.shopify.com/dashboard/${dashboardId}/apps/${appId}/versions/new`;
  await page.goto(versionsNewUrl, { waitUntil: "domcontentloaded" });
  console.log("Versions/new URL:", page.url());
  await sleep(1200);

  // ---- App URL (hard-target by ID) ----
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
    await page.screenshot({ path: "storage/app-url-did-not-stick.png", fullPage: true });
    throw new Error(
      `App URL did not stick. Expected "${appUrl}", got "${appUrlReadback}"`
    );
  }

  // ---- Embed app checkbox (target by label text) ----
  const embedCheckbox = page.getByRole("checkbox", {
    name: /embed app in shopify admin/i,
  });

  if (await embedCheckbox.count()) {
    const checked = await embedCheckbox.isChecked();
    console.log("Embed checked before:", checked);
    if (checked) {
      await embedCheckbox.click({ force: true });
      await sleep(300);
    }
    console.log("Embed checked after:", await embedCheckbox.isChecked());
  } else {
    await page.screenshot({ path: "storage/embed-checkbox-not-found.png", fullPage: true });
    throw new Error('Could not find "Embed app in Shopify admin" checkbox');
  }

  await page.screenshot({
    path: "storage/before-release-after-url-embed.png",
    fullPage: true,
  });

  // ---- Scopes ----
  const scopesField = page.locator("#version_app_module_data_app_access_app_scopes");
  await scopesField.waitFor({ timeout: 30_000 });
  await scopesField.scrollIntoViewIfNeeded();
  await scopesField.click({ force: true });
  await scopesField.fill(scopesCsv);
  await scopesField.blur();

  const scopesRb = (await scopesField.inputValue().catch(() => "")).trim();
  console.log("Filled: Scopes");
  console.log("Scopes readback length:", scopesRb.length);

  // ---- Redirect URLs ----
  const redirectField = page
    .locator(
      [
        'textarea[id*="redirect" i]',
        'textarea[name*="redirect" i]',
        'input[id*="redirect" i]',
        'input[name*="redirect" i]',
      ].join(",")
    )
    .filter({
      hasNot: page.locator("#version_app_module_data_app_access_app_optional_scopes"),
    })
    .first();

  await redirectField.waitFor({ timeout: 30_000 });
  await redirectField.scrollIntoViewIfNeeded();
  await redirectField.click({ force: true });
  await redirectField.fill(redirectUrl);
  await redirectField.blur();

  const redirectRb = (await redirectField.inputValue().catch(() => "")).trim();
  console.log("Redirect readback:", redirectRb);

  // ---- RELEASE ----
  await page.waitForTimeout(500);
  const releaseBtn = page.getByRole("button", { name: /^release$/i }).first();
  await releaseBtn.waitFor({ state: "visible", timeout: 30_000 });

  const disabled = await releaseBtn.isDisabled().catch(() => true);
  console.log("Release visible. Disabled?", disabled);
  await safeScreenshot(page, "storage/before-release.png");

  if (disabled) {
    await safeScreenshot(page, "storage/release-disabled.png");
    throw new Error('Release button is disabled (fields likely not valid / not saved).');
  }

  await releaseBtn.click({ force: true });
  console.log('Clicked: "Release"');
  await page.waitForTimeout(800);

  // Confirm modal ONLY if there is a modal with a "Release" button
  const confirmModalBtn = page
    .locator('[role="dialog"], .Polaris-Modal-Dialog, .Polaris-Modal')
    .getByRole("button", { name: /^release$/i })
    .first();

  if ((await confirmModalBtn.count()) > 0) {
    await confirmModalBtn.waitFor({ state: "visible", timeout: 10_000 });
    await confirmModalBtn.click({ force: true });
    console.log('Clicked: Confirm "Release" (modal)');
  }

  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);

  // Verify by opening Versions list -> Active version
  const versionsListUrl = `https://dev.shopify.com/dashboard/${dashboardId}/apps/${appId}/versions`;
  await page.goto(versionsListUrl, { waitUntil: "domcontentloaded" });
  await sleep(1200);

  const activeLink = page
    .locator('a[href*="/versions/"]')
    .filter({ hasText: /active/i })
    .first();

  const firstVersionLink = page.locator('a[href*="/versions/"]').first();

  if (await activeLink.count()) {
    await activeLink.click({ force: true });
  } else {
    await firstVersionLink.click({ force: true });
  }

  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);

  const activeAppUrl = await page
    .locator("#version_app_module_data_app_home_app_url")
    .inputValue()
    .catch(() => "");

  const activeScopes = await page
    .locator("#version_app_module_data_app_access_app_scopes")
    .inputValue()
    .catch(() => "");

  console.log("VERIFY (active version) app url:", (activeAppUrl || "").trim());
  console.log("VERIFY (active version) scopes len:", (activeScopes || "").trim().length);

  await safeScreenshot(page, "storage/verify-active-version.png");
}

async function selectCustomDistribution(distPage) {
  // A) direct button
  const selectCustomBtn = distPage
    .locator('button:has-text("Select custom distribution")')
    .first();

  if ((await selectCustomBtn.count()) > 0) {
    await selectCustomBtn.waitFor({ timeout: 30_000 });
    await selectCustomBtn.click({ force: true });
    await sleep(800);
    console.log('Clicked: "Select custom distribution" (direct)');
    return;
  }

  // B) click card/section
  const cardTextExact = distPage.locator("text=/^\\s*Custom distribution\\s*$/im").first();
  const cardTextBroad = distPage.locator("text=/custom distribution/i").first();

  if (await cardTextExact.count()) {
    await cardTextExact.waitFor({ timeout: 30_000 });
    await cardTextExact.click({ force: true });
  } else {
    await cardTextBroad.waitFor({ timeout: 30_000 });
    await cardTextBroad.click({ force: true });
  }

  await sleep(500);

  // Then click the green "Select" (NOT "Select custom distribution")
  const selectBtn = distPage
    .locator('button:has-text("Select")')
    .filter({ hasNotText: "Select custom distribution" })
    .first();

  await selectBtn.waitFor({ timeout: 30_000 });
  await selectBtn.click({ force: true });
  await sleep(800);
  console.log('Clicked: "Select" (after choosing custom distribution)');

  // Sometimes a confirmation appears with "Select custom distribution"
  const confirmBtn = distPage
    .locator('button:has-text("Select custom distribution")')
    .first();

  if ((await confirmBtn.count()) > 0) {
    await confirmBtn.click({ force: true });
    await sleep(1000);
    console.log('Clicked: Confirm "Select custom distribution"');
  }
}

async function fillDomainAndGenerateLink(distPage, store_domain) {
  await distPage.waitForSelector("#PolarisTextField1", { timeout: 60_000 });
  const domainInput = distPage.locator("#PolarisTextField1");

  await domainInput.scrollIntoViewIfNeeded();
  await domainInput.click({ force: true });
  await domainInput.fill("");
  await domainInput.type(store_domain, { delay: 25 });

  const typed = await domainInput.inputValue().catch(() => "");
  console.log("Domain typed value:", typed);

  if (typed.trim() !== store_domain) {
    await safeScreenshot(distPage, "storage/domain-did-not-stick.png");
    throw new Error(
      `Domain did not stick. Expected "${store_domain}", got "${typed}". Screenshot: storage/domain-did-not-stick.png`
    );
  }

  console.log("Filled store domain:", store_domain);

  // Click Generate link (first click)
  const genBtn = distPage
    .locator('button:has-text("Generate link"), button:has-text("Generate")')
    .first();

  await genBtn.waitFor({ timeout: 30_000 });
  await genBtn.click({ force: true });
  console.log('Clicked: "Generate link" (first)');
  await sleep(800);

  // Modal confirm "Generate link" (second click)
  const modal = distPage.locator('[role="dialog"], .Polaris-Modal-Dialog, .Polaris-Modal').first();
  if ((await modal.count()) > 0) {
    const modalGen = modal
      .locator('button:has-text("Generate link"), button:has-text("Generate")')
      .first();

    await modalGen.waitFor({ timeout: 30_000 });
    await modalGen.click({ force: true });
    console.log('Clicked: "Generate link" (modal confirm)');
    await sleep(1200);
  } else {
    // fallback
    const anySecond = distPage
      .locator('button:has-text("Generate link"), button:has-text("Generate")')
      .last();

    if ((await anySecond.count()) > 0) {
      await anySecond.click({ force: true });
      console.log('Clicked: "Generate link" (fallback last)');
      await sleep(1200);
    }
  }

  await safeScreenshot(distPage, "storage/distribution-after-generate.png");
  await sleep(900);

  // Scrape install link:
  let link = "";
  try {
    link = (await distPage.getByRole("textbox", { name: /install link/i }).inputValue()).trim();
  } catch {}

  // Fallback: any input containing admin.shopify.com + oauth/install_custom_app
  if (!link) {
    const inputs = distPage.locator("input");
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const v = (await inputs.nth(i).inputValue().catch(() => "")).trim();
      if (
        v.includes("admin.shopify.com") &&
        (v.includes("/oauth/") || v.includes("install_custom_app"))
      ) {
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

  // IMPORTANT: on Render/Docker, keep headless
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    storageState: "storage/shopify-storage.json",
  });

  const page = await context.newPage();

  try {
    // 1) Apps list
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
    console.log("URL now:", page.url());

    // 2) Click "Create app" (first)
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

    // 4) Submit create form (SECOND button on /apps/new) — stable selector
    const submitCreate = page
      .locator('button[data-form-target="submit"][type="submit"]')
      .first();

    await submitCreate.waitFor({ state: "attached", timeout: 120_000 });
    await submitCreate.scrollIntoViewIfNeeded();
    await submitCreate.click({ force: true });
    console.log('Clicked: Submit "Create"');

    // 5) Success check: Shopify lands on /apps/<id>
    await page.waitForURL(/\/apps\/\d+/, { timeout: 120_000 });
    console.log("Created app detail URL:", page.url());

    const appId = extractAppId(page.url());
    if (!appId) {
      await safeScreenshot(page, "storage/create-app-no-appid.png");
      throw new Error(`Create succeeded but couldn't parse appId from URL: ${page.url()}`);
    }

    // 6) Configure version fields + Release + verify active version
    await configureVersionAndRelease(page, { appId, dashboardId });

    // 7) Settings: scrape Client ID/Secret
    const settingsUrl = `https://dev.shopify.com/dashboard/${dashboardId}/apps/${appId}/settings`;
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await sleep(1200);
    console.log("Settings page URL:", page.url());
    await safeScreenshot(page, "storage/app-settings.png");

    const { clientId, clientSecret } = await scrapeClientIdAndSecret(page);

    // 8) Distribution: open partners distribution URL in a new page
    const distributionUrl = `https://partners.shopify.com/${partnersId}/apps/${appId}/distribution`;
    console.log("Distribution page URL:", distributionUrl);

    const distPage = await context.newPage();
    await distPage.goto(distributionUrl, { waitUntil: "domcontentloaded" });
    console.log("Distribution page ACTUAL URL:", distPage.url());

    // Account chooser bounce
    if (distPage.url().includes("accounts.shopify.com/select")) {
      await pickAccountIfNeeded(distPage);
      await waitForAnyURL(distPage, [/partners\.shopify\.com\/\d+\/apps\/\d+\/distribution/], 30_000);
      console.log("After choosing account, URL:", distPage.url());
    }

    await safeScreenshot(distPage, "storage/distribution-before.png");

    // 9) Select custom distribution
    await selectCustomDistribution(distPage);
    console.log("After selecting custom distribution, URL:", distPage.url());
    await safeScreenshot(distPage, "storage/distribution-after-select.png");

    // 10) Fill domain + generate link + scrape
    const distributionLink = await fillDomainAndGenerateLink(distPage, store_domain);
    await safeScreenshot(distPage, "storage/distribution-final.png");

    return {
      app_name: appName,
      client_id: clean(clientId),
      client_secret: clean(clientSecret),
      distribution_link: clean(distributionLink),
      note: "Created app + configured version + released + scraped Client ID/secret + generated distribution link.",
      store_domain,
    };
  } finally {
    await browser.close();
  }
}