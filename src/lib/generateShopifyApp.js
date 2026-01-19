// src/lib/generateShopifyApp.js
import { chromium } from "playwright";

/**
 * End-to-end Shopify Dev Dashboard -> create app -> configure version -> release
 * -> scrape client id/secret -> generate custom distribution install link.
 *
 * Expects these env vars:
 * - SHOPIFY_DEV_DASHBOARD_URL   (e.g. https://dev.shopify.com/dashboard/130027305/apps)
 * - SHOPIFY_PARTNERS_ID         (e.g. 2767396)   [optional; default 2767396]
 * - APP_URL                     (e.g. https://app.retention.com/integrations/oauth2/ShopifyOauth/start)
 * - REDIRECT_URL                (e.g. https://app.retention.com/integrations/oauth2/ShopifyOauth)
 * - SCOPES_CSV                  (comma-separated scopes)
 * - PW_HEADED=1                 (optional; headed mode for debugging)
 *
 * Also uses storageState:
 * - storage/shopify-storage.json  (must exist and be valid logged-in state)
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
      clientSecret =
        tag === "code" ? clean(await c.textContent()) : clean(await c.inputValue());
      if (clientSecret) break;
    } catch {}
  }

  console.log("SCRAPED clientId length:", (clientId || "").length);
  console.log("SCRAPED clientSecret length:", (clientSecret || "").length);

  return { clientId, clientSecret };
}

async function ensureCreatedAppDetailPage(page, dashboardUrl, appName) {
  // If we already have an id, done
  let appId = extractAppId(page.url());
  if (appId) return { appId, url: page.url() };

  // Sometimes there's a direct /apps/<id> link on /apps/new
  try {
    const directHref = await page.locator("a[href]").evaluateAll((els) => {
      const hrefs = els.map((a) => a.getAttribute("href") || "");
      return hrefs.find((h) => /\/apps\/\d+/.test(h)) || null;
    });

    if (directHref) {
      const target = baseDevUrl(directHref);
      await page.goto(target, { waitUntil: "domcontentloaded" });
      await sleep(900);
      appId = extractAppId(page.url());
      if (appId) {
        console.log("Opened app from directHref on create page:", directHref);
        return { appId, url: page.url() };
      }
    }
  } catch {}

  // Go to apps list and retry by name (DO NOT fall back to “first app”)
  await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
  await sleep(1200);

  for (let attempt = 1; attempt <= 10; attempt++) {
    const byName = page.getByRole("link", { name: new RegExp(appName, "i") }).first();
    if ((await byName.count()) > 0) {
      await byName.click({ force: true });
      await page.waitForLoadState("domcontentloaded");
      await sleep(900);
      appId = extractAppId(page.url());
      if (appId) {
        console.log(`Opened app by name: ${appName}`);
        return { appId, url: page.url() };
      }
    }

    console.log(`Waiting for app to appear in list... attempt ${attempt}/10`);
    await safeScreenshot(page, `storage/apps-list-wait-${attempt}.png`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(1500);
  }

  await safeScreenshot(page, "storage/apps-list-not-found.png");
  throw new Error(
    `Created app "${appName}" did not appear in apps list after retries. Screenshot: storage/apps-list-not-found.png`
  );
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
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);

  // ---- App URL ----
  const appUrlInput = page.locator("#version_app_module_data_app_home_app_url");
  await appUrlInput.waitFor({ state: "visible", timeout: 30_000 });
  await appUrlInput.scrollIntoViewIfNeeded();
  await appUrlInput.click({ force: true });
  await appUrlInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await appUrlInput.type(appUrl, { delay: 10 });
  await appUrlInput.press("Tab");

  const appUrlReadback = (await appUrlInput.inputValue()).trim();
  if (appUrlReadback !== appUrl) {
    await page.screenshot({ path: "storage/app-url-did-not-stick.png", fullPage: true });
    throw new Error(`App URL did not stick. Expected "${appUrl}", got "${appUrlReadback}"`);
  }

  // ---- Embed app checkbox ----
  const embedCheckbox = page.getByRole("checkbox", { name: /embed app in shopify admin/i }).first();
  if (!(await embedCheckbox.count())) {
    await page.screenshot({ path: "storage/embed-checkbox-not-found.png", fullPage: true });
    throw new Error('Could not find "Embed app in Shopify admin" checkbox');
  }
  if (await embedCheckbox.isChecked()) {
    await embedCheckbox.click({ force: true });
    await page.waitForTimeout(300);
  }

  // ---- Scopes ----
  const scopesField = page.locator("#version_app_module_data_app_access_app_scopes");
  await scopesField.waitFor({ state: "visible", timeout: 30_000 });
  await scopesField.scrollIntoViewIfNeeded();
  await scopesField.click({ force: true });
  await scopesField.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await scopesField.type(scopesCsv, { delay: 5 });
  await scopesField.press("Tab");

  // ---- Redirect URL ----
  // Try ID-based first, but fall back to label-based if Shopify changes ids.
  let redirectField = page
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

  if (!(await redirectField.count())) {
    // Fallback: find the textbox near label text "Redirect"
    redirectField = page.locator('input:near(:text("Redirect")), textarea:near(:text("Redirect"))').first();
  }

  await redirectField.waitFor({ state: "visible", timeout: 30_000 });
  await redirectField.scrollIntoViewIfNeeded();
  await redirectField.click({ force: true });
  await redirectField.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await redirectField.type(redirectUrl, { delay: 10 });
  await redirectField.press("Tab");

  await page.screenshot({ path: "storage/before-release.png", fullPage: true });


// ---- RELEASE ----

// 1) First "Release" button on the version form (submit button)
const firstReleaseBtn = page.locator('button[type="submit"]', { hasText: /^Release$/i }).first();
await firstReleaseBtn.waitFor({ state: "visible", timeout: 30_000 });

// Wait until enabled
await page.waitForFunction(() => {
  const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
  const b = btns.find(x => (x.textContent || "").trim().toLowerCase() === "release");
  return !!b && !b.disabled;
}, { timeout: 30_000 });

await firstReleaseBtn.scrollIntoViewIfNeeded();
await firstReleaseBtn.click({ force: true });
await safeScreenshot(page, "storage/after-first-release-click.png");

// 2) Second "Release" confirmation button
const confirmReleaseBtn = page.locator(
  'button[data-form-target="submit"][type="submit"]',
  { hasText: /^Release$/i }
).last();

await confirmReleaseBtn.waitFor({ state: "visible", timeout: 30_000 });

await page.waitForFunction(() => {
  const b = document.querySelector('button[data-form-target="submit"][type="submit"]');
  return !!b && !b.disabled;
}, { timeout: 30_000 });

await confirmReleaseBtn.scrollIntoViewIfNeeded();
await confirmReleaseBtn.click({ force: true });
await safeScreenshot(page, "storage/after-second-release-click.png");

await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(1200);

// ---- VERIFY AFTER RELEASE (verify on CURRENT PAGE; no version list click) ----

// Wait for an "Active" indicator if it appears
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

await page.screenshot({ path: "storage/verify-current-version.png", fullPage: true });
}

async function selectCustomDistribution(distPage) {
  // Known patterns:
  // A) button: "Select custom distribution"
  // B) choose card "Custom distribution" then click primary "Select"
  // C) after account chooser, distribution page loads and shows either A or B

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
  // Wait for the Polaris text field we saw in your dumps: #PolarisTextField1
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
  const genBtn = distPage.locator('button:has-text("Generate link"), button:has-text("Generate")').first();
  await genBtn.waitFor({ timeout: 30_000 });
  await genBtn.click({ force: true });
  console.log('Clicked: "Generate link" (first)');
  await sleep(800);

  // Modal confirm "Generate link" (second click)
  const modal = distPage.locator('[role="dialog"], .Polaris-Modal-Dialog, .Polaris-Modal').first();
  if ((await modal.count()) > 0) {
    const modalGen = modal.locator('button:has-text("Generate link"), button:has-text("Generate")').first();
    await modalGen.waitFor({ timeout: 30_000 });
    await modalGen.click({ force: true });
    console.log('Clicked: "Generate link" (modal confirm)');
    await sleep(1200);
  } else {
    // fallback: last matching generate button (sometimes the modal isn't tagged)
    const anySecond = distPage.locator('button:has-text("Generate link"), button:has-text("Generate")').last();
    if ((await anySecond.count()) > 0) {
      await anySecond.click({ force: true });
      console.log('Clicked: "Generate link" (fallback last)');
      await sleep(1200);
    }
  }

  await safeScreenshot(distPage, "storage/distribution-after-generate.png");
  await sleep(900);

// ---- GET INSTALL LINK (scrape first, then Copy fallback) ----
let link = "";
// 1) Try to read from a textbox labeled "Install link"
try {
  link = (await distPage.getByRole("textbox", { name: /install link/i }).inputValue()).trim();
} catch {}

// 2) Fallback: scan inputs for the install URL
if (!link) {
  const inputs = distPage.locator("input, textarea");
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const v = (await inputs.nth(i).inputValue().catch(() => "")).trim();
    if (v.includes("admin.shopify.com") && (v.includes("/oauth/") || v.includes("install_custom_app"))) {
      link = v;
      break;
    }
  }
}

// 3) ALWAYS click Copy (so clipboard gets it)
{
  const copyBtn = distPage
    .locator('button:has-text("Copy"), button:has-text("Copy link"), button:has-text("Copy install")')
    .first();
  const iconCopyBtn = distPage
    .locator('button[aria-label*="copy" i], button[title*="copy" i]')
    .first();

  let clicked = false;

  if ((await copyBtn.count()) > 0) {
    await copyBtn.scrollIntoViewIfNeeded();
    await copyBtn.click({ force: true });
    clicked = true;
  } else if ((await iconCopyBtn.count()) > 0) {
    await iconCopyBtn.scrollIntoViewIfNeeded();
    await iconCopyBtn.click({ force: true });
    clicked = true;
  }

  if (clicked) {
    console.log("✅ CLICKED COPY button (forced)");
    await safeScreenshot(distPage, "storage/after-copy-click.png");
    await sleep(400);
    // Optional: verify clipboard (requires permissions)
    try {
      const clip = (await distPage.evaluate(() => navigator.clipboard.readText())).trim();
      console.log("Clipboard read length:", clip.length);
    } catch (e) {
      console.log("Clipboard read failed:", e?.message || e);
    }
  } else {
    console.log("⚠️ No COPY button found to click.");
  }
}
}


async function generateShopifyApp({ brand_name, store_domain }) {
  const dashboardUrl = process.env.SHOPIFY_DEV_DASHBOARD_URL;
  const partnersId = process.env.SHOPIFY_PARTNERS_ID || "2767396";

  if (!dashboardUrl) throw new Error("Missing env var: SHOPIFY_DEV_DASHBOARD_URL");
  if (!brand_name || typeof brand_name !== "string") throw new Error("brand_name is required");
  if (!store_domain || typeof store_domain !== "string") throw new Error("store_domain is required");

  const dashboardId = dashboardIdFromUrl(dashboardUrl);
  const appName = `${brand_name} x Retention`;

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

    // 2) Create app
    const createApp = page.locator('text=/Create\\s+app/i').first();
    await createApp.waitFor({ timeout: 30_000 });
    await createApp.click({ force: true });
    console.log("Clicked: Create app");

    await page.waitForURL(/\/apps\/new\b/, { timeout: 30_000 });
    console.log("After clicking Create app, URL:", page.url());

    // Fill name (you discovered: #app_form_name / input[name="app_form[name]"])
    const nameInput = page.locator("#app_form_name").first();
    await nameInput.waitFor({ timeout: 30_000 });
    await nameInput.click({ force: true });
    await nameInput.fill("");
    await nameInput.type(appName, { delay: 20 });



// Submit create form (the SECOND "Create app" on the /apps/new page)
await page.waitForURL(/\/apps\/new\b/, { timeout: 30_000 });

// Shopify can render multiple "Create app" buttons; click the one in the form footer
const submitCreate = page
  .getByRole("button", { name: /^Create app$/i })
  .filter({ hasNotText: /create an app/i }) // avoid header/banner variants if any
  .last();

await submitCreate.waitFor({ timeout: 120_000 });
await submitCreate.click({ force: true });
console.log("Submitted: Create app");

   // Success check = we landed on the new app detail page
   await page.waitForURL(/\/apps\/\d+/, { timeout: 60_000 });
   console.log("Created app detail URL:", page.url());

   // ✅ then continue with your existing code that reads client_id/secret/link from the app page

    // Submit button (Shopify UI varies)
    const submitBtn = page
      .locator("button")
      .filter({ hasText: /^(Create app|Create|Submit)$/i })
      .first();

    await submitBtn.waitFor({ timeout: 30_000 });
    await submitBtn.scrollIntoViewIfNeeded();
    await submitBtn.click({ force: true });
    console.log("Clicked: Submit create app");

    // Wait briefly; Shopify often stays on /apps/new
    await sleep(1500);
    await page.waitForLoadState("domcontentloaded");
    console.log("After submitting create form, URL:", page.url());

    // 3) Ensure we open the app we just created (by name, retry)
    const { appId } = await ensureCreatedAppDetailPage(page, dashboardUrl, appName);
    console.log("App detail page URL:", page.url());

    // 4) Configure version fields + Release + verify active version
    await configureVersionAndRelease(page, { appId, dashboardId });

    // 5) Back to Settings and scrape Client ID/Secret
    const settingsUrl = `https://dev.shopify.com/dashboard/${dashboardId}/apps/${appId}/settings`;
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await sleep(1200);
    console.log("Settings page URL:", page.url());
    await safeScreenshot(page, "storage/app-settings.png");

    const { clientId, clientSecret } = await scrapeClientIdAndSecret(page);

    // 6) Distribution: open partners distribution URL in a new page (avoids “new tab” issues)
    const distributionUrl = `https://partners.shopify.com/${partnersId}/apps/${appId}/distribution`;
    console.log("Distribution page URL:", distributionUrl);

    const distPage = await context.newPage();
    await distPage.goto(distributionUrl, { waitUntil: "domcontentloaded" });
    console.log("Distribution page ACTUAL URL:", distPage.url());

    // Account chooser bounce
    if (distPage.url().includes("accounts.shopify.com/select")) {
      await pickAccountIfNeeded(distPage);
      await waitForAnyURL(
        distPage,
        [/partners\.shopify\.com\/\d+\/apps\/\d+\/distribution/],
        30_000
      );
      console.log("After choosing account, URL:", distPage.url());
    }

    await safeScreenshot(distPage, "storage/distribution-before.png");

    // 7) Select custom distribution + Select/confirm
    await selectCustomDistribution(distPage);
    console.log("After selecting custom distribution, URL:", distPage.url());
    await safeScreenshot(distPage, "storage/distribution-after-select.png");

    // 8) Fill domain + generate link + scrape
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

export { generateShopifyApp };
