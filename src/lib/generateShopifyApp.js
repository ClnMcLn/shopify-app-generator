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

async function pickAccountIfNeeded(page, partnersDistributionUrl) {
  const url = page.url();
  if (!url.includes("accounts.shopify.com/select")) return;

  console.log("On account chooser — bypassing to partners distribution", { url });
  await safeScreenshot(page, "storage/account-chooser-arrived.png");

  // Try a few times: sometimes Shopify keeps redirecting back to chooser
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`Chooser bypass attempt ${attempt}: goto partners distribution`);
    await page.goto(partnersDistributionUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const now = page.url();
    console.log("After goto, URL:", now);
    await safeScreenshot(page, `storage/account-chooser-bypass-attempt-${attempt}.png`);

    if (now.includes("partners.shopify.com")) return;
    if (!now.includes("accounts.shopify.com/select")) return; // some other redirect, let caller handle
  }

  throw new Error(
    `Account chooser bypass failed; still on chooser after retries. Current: ${page.url()}`
  );
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

// Confirm release: sometimes it's a modal, sometimes it's a second button on the page
const confirmReleaseBtn = page
  .getByRole("button", { name: /^release$/i })
  .filter({ hasNotText: /create an app/i })
  .last();

await confirmReleaseBtn.waitFor({ state: "visible", timeout: 30_000 });
await confirmReleaseBtn.click({ force: true });
console.log('Clicked: Confirm "Release"');
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);

// ---- VERIFY AFTER RELEASE (verify on CURRENT PAGE; no version list click) ----
// Wait for an "Active" indicator if it appears (don’t fail if it doesn’t)
await page.getByText(/Active/i).first().waitFor({ timeout: 30_000 }).catch(() => {});

// Verify fields on the *current* version detail page
const vAppUrl = (await page
  .locator("#version_app_module_data_app_home_app_url")
  .inputValue()
  .catch(() => "")).trim();

const vScopes = (await page
  .locator("#version_app_module_data_app_access_app_scopes")
  .inputValue()
  .catch(() => "")).trim();

console.log("VERIFY (current page) app url:", vAppUrl);
console.log("VERIFY (current page) scopes len:", vScopes.length);

await safeScreenshot(page, "storage/verify-current-version.png");
}

async function selectCustomDistribution(distPage) {
  // 0) Sanity: ensure we’re on a partners distribution page and it has rendered something
  await distPage.waitForLoadState("domcontentloaded").catch(() => {});
  await distPage.waitForTimeout(1000);

  const u = distPage.url();
  console.log("selectCustomDistribution() URL:", u);
  await safeScreenshot(distPage, "storage/distribution-selectCustom-start.png");

  if (!u.includes("partners.shopify.com")) {
    throw new Error(`Not on partners distribution page. URL: ${u}`);
  }

  // 1) Wait for ANY anchor that indicates the distribution UI is present
  const uiAnchor = distPage.locator(
    [
      'text=/distribution/i',
      'text=/custom distribution/i',
      'text=/select custom distribution/i',
      'text=/generate link/i',
      '#PolarisTextField1',
      'button:has-text("Select")',
      'button:has-text("Continue")',
    ].join(",")
  );

  await uiAnchor.first().waitFor({ state: "visible", timeout: 90_000 });
  await safeScreenshot(distPage, "storage/distribution-ui-anchor-visible.png");

  // 2) If we already see the domain field / generate link, custom distribution is already selected
  const domainField = distPage.locator("#PolarisTextField1");
  const genBtn = distPage.locator('button:has-text("Generate link"), button:has-text("Generate")');

  if ((await domainField.count()) > 0 || (await genBtn.count()) > 0) {
    console.log("Custom distribution appears already selected (domain/generate UI present).");
    return;
  }

  // 3) Path A: direct button exists
  const direct = distPage.locator('button:has-text("Select custom distribution")').first();
  if ((await direct.count()) > 0) {
    await direct.waitFor({ state: "visible", timeout: 30_000 });
    await direct.click({ force: true });
    console.log('Clicked: "Select custom distribution" (direct button)');
    await distPage.waitForTimeout(1500);
    await safeScreenshot(distPage, "storage/distribution-after-direct-select.png");
    return;
  }

  // 4) Path B: click the “Custom distribution” card/row/text (UI varies)
  const customText = distPage.locator("text=/custom distribution/i").first();
  if ((await customText.count()) > 0) {
    await customText.waitFor({ state: "visible", timeout: 30_000 });
    await customText.click({ force: true });
    console.log('Clicked: "Custom distribution" (card/text)');
    await distPage.waitForTimeout(800);
  }

  // 5) Path C: there is usually a generic Select / Continue after choosing the method
  const nextBtn = distPage
    .locator('button:has-text("Select"), button:has-text("Continue"), button:has-text("Next")')
    .filter({ hasNotText: /select custom distribution/i })
    .first();

  if ((await nextBtn.count()) > 0) {
    await nextBtn.waitFor({ state: "visible", timeout: 30_000 });
    await nextBtn.click({ force: true });
    console.log('Clicked: "Select/Continue/Next" after choosing method');
    await distPage.waitForTimeout(1500);
  }

  // 6) Confirm we landed on the custom distribution UI
  if ((await distPage.locator("#PolarisTextField1").count()) === 0) {
    await safeScreenshot(distPage, "storage/distribution-custom-not-reached.png");
    throw new Error(
      `Could not reach Custom distribution UI (missing #PolarisTextField1). URL: ${distPage.url()}`
    );
  }

  console.log("Custom distribution UI reached.");
  await safeScreenshot(distPage, "storage/distribution-custom-reached.png");
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
  await pickAccountIfNeeded(distPage, distributionUrl);
}

if (!distPage.url().includes("partners.shopify.com")) {
  await safeScreenshot(distPage, "storage/distribution-not-on-partners.png");
  throw new Error(`Still not on partners distribution page. URL: ${distPage.url()}`);
}

console.log("On partners distribution page:", distPage.url());


    console.log("Distribution page after chooser bypass:", distPage.url());

    await safeScreenshot(distPage, "storage/distribution-before.png");

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
