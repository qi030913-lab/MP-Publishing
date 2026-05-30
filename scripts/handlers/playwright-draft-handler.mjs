const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readBoolean(name, fallback = false) {
  const value = readEnv(name);
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readInteger(name, fallback) {
  const value = readEnv(name);
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return parsed;
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function selectorValue(selectors, name) {
  const value = selectors?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readJsonFile(filePath) {
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function readSelectors(platform) {
  const envPrefix = `DRAFT_AUTOMATION_${platform.toUpperCase()}`;
  const raw =
    readEnv(`${envPrefix}_PLAYWRIGHT_SELECTORS_JSON`) ??
    readEnv("DRAFT_AUTOMATION_PLAYWRIGHT_SELECTORS_JSON");
  if (raw) {
    return JSON.parse(raw);
  }

  const path =
    readEnv(`${envPrefix}_PLAYWRIGHT_SELECTORS_PATH`) ??
    readEnv(`${envPrefix}_PLAYWRIGHT_SELECTORS_FILE`) ??
    readEnv("DRAFT_AUTOMATION_PLAYWRIGHT_SELECTORS_PATH") ??
    readEnv("DRAFT_AUTOMATION_PLAYWRIGHT_SELECTORS_FILE");
  if (path) {
    return readJsonFile(path);
  }

  return undefined;
}

function validateSelectors(platform, selectors, { requireSaveDraft = false } = {}) {
  if (!selectors || typeof selectors !== "object" || Array.isArray(selectors)) {
    throw new Error(`${platform} Playwright selectors must be configured with *_PLAYWRIGHT_SELECTORS_JSON or *_PLAYWRIGHT_SELECTORS_PATH.`);
  }

  for (const key of ["title", "body"]) {
    if (!selectorValue(selectors, key)) {
      throw new Error(`${platform} Playwright selectors must include "${key}".`);
    }
  }

  if (requireSaveDraft && !selectorValue(selectors, "saveDraft")) {
    throw new Error(`${platform} Playwright selectors must include "saveDraft" when click-save is enabled.`);
  }
}

async function importPlaywright() {
  const moduleName = readEnv("DRAFT_AUTOMATION_PLAYWRIGHT_MODULE") ?? "playwright";
  const loaded = await import(moduleName);
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  if (!chromium?.launch) {
    throw new Error(`${moduleName} must export chromium.launch().`);
  }

  return { chromium };
}

function parseCookieHeader(cookies, url) {
  if (!cookies) {
    return [];
  }

  const parsedUrl = new URL(url);
  return cookies
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      const name = separator > -1 ? part.slice(0, separator).trim() : part;
      const value = separator > -1 ? part.slice(separator + 1).trim() : "";
      return {
        name,
        value,
        domain: parsedUrl.hostname,
        path: "/",
        httpOnly: false,
        secure: parsedUrl.protocol === "https:",
        sameSite: "Lax",
      };
    });
}

function createStorageState(platformSession) {
  if (platformSession?.storageStatePath) {
    return platformSession.storageStatePath;
  }

  if (platformSession?.storageStateJson) {
    return JSON.parse(platformSession.storageStateJson);
  }

  return undefined;
}

async function fillSelector(page, selector, value) {
  if (!selector || value === undefined || value === null || value === "") {
    return;
  }

  await page.locator(selector).fill(String(value));
}

async function maybeClick(page, selector, timeout) {
  if (!selector) {
    return false;
  }

  await page.locator(selector).click({ timeout });
  return true;
}

async function readResultUrl(page, selectors) {
  const selector = selectorValue(selectors, "resultUrl");
  if (!selector) {
    return page.url();
  }

  const attribute = asString(selectors.resultUrlAttribute) ?? "href";
  const value = await page.locator(selector).getAttribute(attribute);
  const resultUrl = asString(value);
  return resultUrl ? new URL(resultUrl, page.url()).href : page.url();
}

async function waitAfterSave(page, selectors, timeout) {
  const waitForUrl = asString(selectors.waitForUrl);
  if (waitForUrl) {
    await page.waitForURL(waitForUrl, { timeout });
  }

  const savedIndicator = selectorValue(selectors, "savedIndicator");
  if (savedIndicator) {
    await page.locator(savedIndicator).waitFor({ timeout });
  }
}

function extractRemoteId(platform, resultUrl, selectors, workOrder) {
  const regexSource = asString(selectors.remoteIdRegex) ?? readEnv(`DRAFT_AUTOMATION_${platform.toUpperCase()}_REMOTE_ID_REGEX`);
  if (regexSource) {
    const match = new RegExp(regexSource).exec(resultUrl);
    if (match?.[1]) {
      return match[1];
    }
  }

  const pathname = new URL(resultUrl).pathname;
  const lastSegment = pathname.split("/").filter(Boolean).at(-1);
  return lastSegment ? `${platform}-${lastSegment}` : `${platform}-${workOrder.remoteId}`;
}

function resolveCreatorDraftUrl({ platformSession, platform }) {
  return (
    platformSession?.creatorDraftUrl ??
    readEnv(`DRAFT_AUTOMATION_${platform.toUpperCase()}_CREATOR_DRAFT_URL`) ??
    readEnv("DRAFT_AUTOMATION_CREATOR_DRAFT_URL")
  );
}

function readPlaywrightSettings(platform) {
  return {
    timeout: readInteger("DRAFT_AUTOMATION_PLAYWRIGHT_TIMEOUT_MS", 30000),
    headless: readBoolean("DRAFT_AUTOMATION_PLAYWRIGHT_HEADLESS", true),
    clickSave: readBoolean(
      `DRAFT_AUTOMATION_${platform.toUpperCase()}_PLAYWRIGHT_CLICK_SAVE`,
      readBoolean("DRAFT_AUTOMATION_PLAYWRIGHT_CLICK_SAVE", true),
    ),
    browserChannel: readEnv("DRAFT_AUTOMATION_PLAYWRIGHT_BROWSER_CHANNEL"),
  };
}

function summarizeSessionAuthModes(platformSession) {
  return [
    platformSession?.appId && platformSession?.appSecret ? "app-secret" : undefined,
    platformSession?.accessToken ? "access-token" : undefined,
    platformSession?.refreshToken ? "refresh-token" : undefined,
    platformSession?.cookies ? "cookies" : undefined,
    platformSession?.storageStateJson ? "storage-state-json" : undefined,
    platformSession?.storageStatePath ? "storage-state-path" : undefined,
  ].filter(Boolean);
}

async function createDraftPage({ platform, platformSession, creatorDraftUrl }) {
  const { timeout, headless, browserChannel } = readPlaywrightSettings(platform);
  const { chromium } = await importPlaywright();
  const browser = await chromium.launch({
    headless,
    ...(browserChannel ? { channel: browserChannel } : {}),
  });

  const storageState = createStorageState(platformSession);
  const context = await browser.newContext({
    ...(storageState ? { storageState } : {}),
  });
  const cookies = parseCookieHeader(platformSession?.cookies, platformSession?.creatorBaseUrl ?? creatorDraftUrl);
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  const page = await context.newPage();
  page.setDefaultTimeout?.(timeout);
  await page.goto(creatorDraftUrl, { waitUntil: "domcontentloaded", timeout });
  return { browser, page, timeout };
}

async function checkSelector(page, selectors, key, timeout, required) {
  const selector = selectorValue(selectors, key);
  if (!selector) {
    return { key, required, configured: false, ok: !required };
  }

  await page.locator(selector).waitFor({ timeout });
  return { key, required, configured: true, selector, ok: true };
}

async function maybeCheckLoggedOutIndicator(page, selectors, timeout) {
  const selector = selectorValue(selectors, "loggedOutIndicator");
  if (!selector) {
    return undefined;
  }

  const shortTimeout = Math.min(timeout, 1500);
  try {
    await page.locator(selector).waitFor({ timeout: shortTimeout });
    throw new Error("visible");
  } catch (error) {
    if (error instanceof Error && error.message === "visible") {
      throw new Error("Logged-out indicator is visible; refresh the platform session before creating drafts.");
    }
    return {
      key: "loggedOutIndicator",
      required: false,
      configured: true,
      selector,
      ok: true,
      detail: "not visible during the short login guard window",
    };
  }
}

export async function checkDraftSetup({ platform, platformSession, screenshotPath, includeOptionalSelectors = true } = {}) {
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`Unsupported platform for Playwright draft handler: ${platform}`);
  }

  const creatorDraftUrl = resolveCreatorDraftUrl({ platformSession, platform });
  if (!creatorDraftUrl) {
    throw new Error(`${platform} creator draft URL is required before checking Playwright automation.`);
  }

  const selectors = await readSelectors(platform);
  validateSelectors(platform, selectors);

  const { browser, page, timeout } = await createDraftPage({ platform, platformSession, creatorDraftUrl });
  try {
    const selectorChecks = [
      await checkSelector(page, selectors, "title", timeout, true),
      await checkSelector(page, selectors, "body", timeout, true),
    ];
    const optionalKeys = ["summary", "tags", "saveDraft", "savedIndicator", "resultUrl", "loginIndicator"];
    if (includeOptionalSelectors) {
      for (const key of optionalKeys) {
        selectorChecks.push(await checkSelector(page, selectors, key, timeout, false));
      }
      const loggedOutCheck = await maybeCheckLoggedOutIndicator(page, selectors, timeout);
      if (loggedOutCheck) {
        selectorChecks.push(loggedOutCheck);
      }
    }

    if (screenshotPath) {
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    return {
      ok: true,
      platform,
      creatorDraftUrl: page.url(),
      sessionAuthModes: summarizeSessionAuthModes(platformSession),
      selectors: selectorChecks,
      ...(screenshotPath ? { screenshotPath } : {}),
    };
  } finally {
    await browser.close();
  }
}

export async function createDraft({ platform, workOrder, platformSession, sessionSummary }) {
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`Unsupported platform for Playwright draft handler: ${platform}`);
  }

  const creatorDraftUrl = resolveCreatorDraftUrl({ platformSession, platform });
  if (!creatorDraftUrl) {
    throw new Error(`${platform} creator draft URL is required before running Playwright automation.`);
  }

  const selectors = await readSelectors(platform);
  const { timeout, clickSave } = readPlaywrightSettings(platform);
  validateSelectors(platform, selectors, { requireSaveDraft: clickSave });
  const { browser, page } = await createDraftPage({ platform, platformSession, creatorDraftUrl });

  try {
    const draft = workOrder.draft ?? {};
    await fillSelector(page, selectorValue(selectors, "title"), draft.title);
    await fillSelector(page, selectorValue(selectors, "summary"), draft.summary);
    await fillSelector(page, selectorValue(selectors, "body"), draft.renderedBody ?? draft.body);

    const hashtags = Array.isArray(draft.hashtags) ? draft.hashtags.filter(Boolean) : [];
    await fillSelector(page, selectorValue(selectors, "tags"), hashtags.join(" "));

    if (clickSave) {
      await maybeClick(page, selectorValue(selectors, "saveDraft"), timeout);
      await waitAfterSave(page, selectors, timeout);
    }

    const resultUrl = await readResultUrl(page, selectors);
    const remoteId = extractRemoteId(platform, resultUrl, selectors, workOrder);
    const sessionAuthModes = Array.isArray(sessionSummary?.authModes) ? sessionSummary.authModes.join(", ") : "none";

    return {
      ok: true,
      remoteId,
      url: resultUrl,
      state: "ready",
      detail: `${platform} creator draft filled by Playwright handler using session modes: ${sessionAuthModes}.`,
    };
  } finally {
    await browser.close();
  }
}
