#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);
const defaultFields = ["title", "body", "saveDraft"];

const fieldDescriptions = {
  title: "Click the draft title input.",
  body: "Click the main body editor.",
  saveDraft: "Click the save-draft button.",
  summary: "Click the summary/description input.",
  tags: "Click the tags input.",
  savedIndicator: "Click an element that appears after saving succeeds.",
  resultUrl: "Click the draft detail link or an element containing the saved draft URL.",
  loginIndicator: "Click an element visible only while logged in.",
  loggedOutIndicator: "Click an element visible only while logged out.",
};

const usageText = `Usage:
  pnpm drafts:capture-playwright-selectors -- --platform zhihu --url https://creator.example.test/drafts/new --save-env

Options:
  --platform <platform>            Required: zhihu, bilibili, or xiaohongshu.
  --url <url>                      Creator page to open; defaults to DRAFT_AUTOMATION_<PLATFORM>_CREATOR_DRAFT_URL.
  --output <path>                  Defaults to .runtime/draft-selectors/<platform>-selectors.json.
  --fields <csv>                   Selector keys to capture; defaults to title,body,saveDraft.
  --wait-for-selector <selector>   Wait for an existing post-login selector before capture.
  --wait-ms <ms>                   Fixed wait before capture when no selector is provided; defaults to 1000.
  --timeout-ms <ms>                Overrides DRAFT_AUTOMATION_PLAYWRIGHT_TIMEOUT_MS.
  --headless                       Capture without an interactive browser window.
  --browser-channel <value>        Browser channel to launch; defaults to DRAFT_AUTOMATION_PLAYWRIGHT_BROWSER_CHANNEL.
  --save-env                       Write PLAYWRIGHT_SELECTORS_PATH and CREATOR_DRAFT_URL to .env.
  --target-env-file <path>         Defaults to .env when --save-env is used.
  --help

During capture, click the highlighted target element for each field. Press Escape to skip an optional field.
Edit the generated JSON afterward if a platform needs custom waitForUrl, remoteIdRegex, or resultUrlAttribute values.`;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > -1) {
      parsed[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readOption(args, name, envNames = []) {
  if (args[name] !== undefined) {
    return args[name] === true ? "" : String(args[name]);
  }

  for (const envName of envNames) {
    const value = readEnv(envName);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function readBoolean(args, name, envNames = []) {
  if (args[name] === true) {
    return true;
  }

  if (args[name] !== undefined) {
    return ["1", "true", "yes", "on"].includes(String(args[name]).toLowerCase());
  }

  for (const envName of envNames) {
    if (process.env[envName] !== undefined) {
      return ["1", "true", "yes", "on"].includes(String(process.env[envName]).toLowerCase());
    }
  }

  return false;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return parsed;
}

function requirePlatform(value) {
  const platform = String(value ?? "").trim();
  if (!supportedPlatforms.has(platform)) {
    throw new Error("--platform must be one of zhihu, bilibili, xiaohongshu.");
  }

  return platform;
}

function requireHttpUrl(value, label) {
  if (!value) {
    throw new Error(`${label} is required.`);
  }

  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }

  return url.href;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function parseFields(value) {
  const fields = String(value ?? defaultFields.join(","))
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (fields.length === 0) {
    throw new Error("--fields must include at least one selector key.");
  }

  return [...new Set(fields)];
}

function quoteEnvValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function updateEnvContent(content, updates) {
  const remaining = new Map(updates);
  const lines = content.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      return line;
    }

    const key = match[1];
    if (!remaining.has(key)) {
      return line;
    }

    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${quoteEnvValue(value)}`;
  });

  if (remaining.size > 0) {
    if (lines.at(-1)?.trim()) {
      lines.push("");
    }

    lines.push("# Playwright creator-center selector capture.");
    for (const [key, value] of remaining) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

async function writeEnvFile(envPath, updates) {
  const examplePath = path.join(root, ".env.example");
  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) {
      throw new Error(`Cannot create ${envPath}; .env.example is missing.`);
    }

    await mkdir(path.dirname(envPath), { recursive: true });
    await copyFile(examplePath, envPath);
  }

  const current = await readFile(envPath, "utf8");
  await writeFile(envPath, updateEnvContent(current, updates), "utf8");
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

function readInitialStorageState(platform, args) {
  const envPrefix = `DRAFT_AUTOMATION_${platform.toUpperCase()}`;
  const storageStatePath = readOption(args, "storage-state-path", [
    `${envPrefix}_STORAGE_STATE_PATH`,
    `${envPrefix}_STORAGE_STATE_FILE`,
  ]);
  if (storageStatePath) {
    return resolvePath(storageStatePath);
  }

  const storageStateJson = readOption(args, "storage-state-json", [`${envPrefix}_STORAGE_STATE_JSON`]);
  if (storageStateJson) {
    return JSON.parse(storageStateJson);
  }

  return undefined;
}

function selectorCaptureScript() {
  if (window.__mpDraftSelectorCaptureInstalled) {
    return;
  }
  window.__mpDraftSelectorCaptureInstalled = true;

  const state = {
    key: undefined,
    label: "",
    required: true,
  };

  const style = document.createElement("style");
  style.textContent = `
    #mp-draft-selector-capture-overlay {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      max-width: min(720px, calc(100vw - 32px));
      padding: 12px 14px;
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 8px;
      background: rgba(17, 24, 39, 0.95);
      color: #fff;
      box-shadow: 0 14px 38px rgba(0, 0, 0, 0.28);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
    }
    .mp-draft-selector-capture-target {
      outline: 3px solid #38bdf8 !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
    }
  `;
  document.documentElement.appendChild(style);

  const overlay = document.createElement("div");
  overlay.id = "mp-draft-selector-capture-overlay";
  document.documentElement.appendChild(overlay);

  function updateOverlay() {
    overlay.textContent = state.required
      ? `${state.label} Click the matching element.`
      : `${state.label} Click the matching element, or press Escape to skip.`;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(value);
    }

    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function unique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function attributeSelector(element, name) {
    const value = element.getAttribute(name);
    if (!value || value.length > 120) {
      return undefined;
    }

    const escapedValue = String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const selector = `${element.tagName.toLowerCase()}[${name}="${escapedValue}"]`;
    return unique(selector) ? selector : undefined;
  }

  function nthOfType(element) {
    const parent = element.parentElement;
    if (!parent) {
      return element.tagName.toLowerCase();
    }

    const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
    const index = siblings.indexOf(element) + 1;
    return `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
  }

  function actionableElement(element) {
    return (
      element.closest?.('input, textarea, button, a, [contenteditable="true"], [role="button"], [role="textbox"]') ??
      element
    );
  }

  function selectorFor(element) {
    if (!(element instanceof Element)) {
      return undefined;
    }

    if (element.id) {
      const selector = `#${cssEscape(element.id)}`;
      if (unique(selector)) {
        return selector;
      }
    }

    for (const name of ["data-testid", "data-test", "data-cy", "name", "aria-label", "placeholder", "role"]) {
      const selector = attributeSelector(element, name);
      if (selector) {
        return selector;
      }
    }

    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const classNames = Array.from(current.classList)
        .filter((className) => className !== "mp-draft-selector-capture-target" && /^[A-Za-z0-9_-]+$/.test(className))
        .slice(0, 2);
      if (classNames.length > 0) {
        part += `.${classNames.map(cssEscape).join(".")}`;
      }

      const candidate = [part, ...parts].join(" > ");
      if (unique(candidate)) {
        return candidate;
      }

      parts.unshift(nthOfType(current));
      const nthCandidate = parts.join(" > ");
      if (unique(nthCandidate)) {
        return nthCandidate;
      }

      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function complete(payload) {
    window.__mpDraftSelectorCaptureResult?.(payload);
  }

  window.__mpDraftSelectorCaptureSetStep = (step) => {
    state.key = step.key;
    state.label = step.label;
    state.required = step.required;
    updateOverlay();
  };

  document.addEventListener(
    "mouseover",
    (event) => {
      if (event.target instanceof Element && event.target.id !== overlay.id) {
        event.target.classList.add("mp-draft-selector-capture-target");
      }
    },
    true,
  );

  document.addEventListener(
    "mouseout",
    (event) => {
      if (event.target instanceof Element) {
        event.target.classList.remove("mp-draft-selector-capture-target");
      }
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!state.key || !(event.target instanceof Element) || event.target.id === overlay.id) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const target = actionableElement(event.target);
      const selector = selectorFor(target);
      complete({
        action: "capture",
        key: state.key,
        selector,
        tagName: target.tagName.toLowerCase(),
        text: (target.textContent ?? "").trim().slice(0, 80),
      });
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || state.required) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      complete({ action: "skip", key: state.key });
    },
    true,
  );
}

async function captureSelectors(options) {
  const { chromium } = await importPlaywright();
  const browser = await chromium.launch({
    headless: options.headless,
    ...(options.browserChannel ? { channel: options.browserChannel } : {}),
  });

  try {
    const context = await browser.newContext({
      ...(options.initialStorageState ? { storageState: options.initialStorageState } : {}),
    });
    const cookies = parseCookieHeader(options.cookies, options.url);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    const page = await context.newPage();
    page.setDefaultTimeout?.(options.timeoutMs);
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });

    if (options.waitForSelector) {
      await page.locator(options.waitForSelector).waitFor({ timeout: options.timeoutMs });
    } else if (options.waitMs > 0) {
      await page.waitForTimeout?.(options.waitMs);
    }

    let pendingResolve;
    await page.exposeFunction("__mpDraftSelectorCaptureResult", (payload) => {
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = undefined;
        resolve(payload);
      }
    });
    await page.evaluate(selectorCaptureScript);

    const selectors = {};
    const captured = [];
    const skipped = [];

    for (const key of options.fields) {
      const required = key === "title" || key === "body";
      const label = fieldDescriptions[key] ?? `Click selector target for "${key}".`;
      const payloadPromise = new Promise((resolve) => {
        pendingResolve = resolve;
      });
      await page.evaluate(
        (step) => {
          window.__mpDraftSelectorCaptureSetStep(step);
        },
        { key, label, required },
      );

      const payload = await payloadPromise;
      if (payload?.action === "skip") {
        skipped.push(key);
        continue;
      }

      if (!payload?.selector) {
        throw new Error(`Could not compute a selector for ${key}. Try a more specific target element.`);
      }

      selectors[key] = payload.selector;
      captured.push({ key, selector: payload.selector, tagName: payload.tagName, text: payload.text });
      console.error(`Captured ${key}: ${payload.selector}`);
    }

    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(
      options.outputPath,
      `${JSON.stringify(
        {
          $schema: "https://mp-publishing.local/draft-playwright-selectors.schema.json",
          platform: options.platform,
          capturedAt: new Date().toISOString(),
          creatorDraftUrl: page.url(),
          ...selectors,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    return {
      finalUrl: page.url(),
      selectors,
      captured,
      skipped,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText);
    return;
  }

  const platform = requirePlatform(readOption(args, "platform"));
  const envPrefix = `DRAFT_AUTOMATION_${platform.toUpperCase()}`;
  const url = requireHttpUrl(
    readOption(args, "url", [`${envPrefix}_CREATOR_DRAFT_URL`, `${envPrefix}_CREATOR_BASE_URL`]),
    "--url or DRAFT_AUTOMATION_<PLATFORM>_CREATOR_DRAFT_URL",
  );
  const outputPath = resolvePath(
    readOption(args, "output", [`${envPrefix}_PLAYWRIGHT_SELECTORS_PATH`]) ??
      `.runtime/draft-selectors/${platform}-selectors.json`,
  );
  const fields = parseFields(readOption(args, "fields", [`${envPrefix}_PLAYWRIGHT_SELECTOR_CAPTURE_FIELDS`]));
  const waitForSelector = readOption(args, "wait-for-selector", [`${envPrefix}_CAPTURE_WAIT_FOR_SELECTOR`]);
  const timeoutMs = parseNonNegativeInteger(
    readOption(args, "timeout-ms", ["DRAFT_AUTOMATION_PLAYWRIGHT_TIMEOUT_MS"]) ?? "30000",
    "--timeout-ms",
  );
  const waitMs = parseNonNegativeInteger(
    readOption(args, "wait-ms", [`${envPrefix}_SELECTOR_CAPTURE_WAIT_MS`, "DRAFT_AUTOMATION_PLAYWRIGHT_SELECTOR_CAPTURE_WAIT_MS"]) ??
      "1000",
    "--wait-ms",
  );
  const browserChannel = readOption(args, "browser-channel", ["DRAFT_AUTOMATION_PLAYWRIGHT_BROWSER_CHANNEL"]);
  const headless = readBoolean(args, "headless", ["DRAFT_AUTOMATION_PLAYWRIGHT_SELECTOR_CAPTURE_HEADLESS"]);
  const cookies = readOption(args, "cookies", [`${envPrefix}_COOKIES`]);
  const initialStorageState = readInitialStorageState(platform, args);

  const result = await captureSelectors({
    platform,
    url,
    outputPath,
    fields,
    waitForSelector,
    timeoutMs,
    waitMs,
    browserChannel,
    headless,
    cookies,
    initialStorageState,
  });

  const saveEnv = readBoolean(args, "save-env");
  if (saveEnv) {
    const envPath = resolvePath(readOption(args, "target-env-file", ["DRAFT_AUTOMATION_CAPTURE_ENV_FILE"]) ?? ".env");
    await writeEnvFile(
      envPath,
      new Map([
        [`${envPrefix}_CREATOR_DRAFT_URL`, url],
        [`${envPrefix}_PLAYWRIGHT_SELECTORS_PATH`, path.relative(root, outputPath).replaceAll("\\", "/")],
      ]),
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        platform,
        url,
        finalUrl: result.finalUrl,
        outputPath,
        savedEnv: saveEnv,
        fields,
        captured: result.captured.map((item) => ({ key: item.key, selector: item.selector })),
        skipped: result.skipped,
        hasInitialStorageState: Boolean(initialStorageState),
        hasCookieSeed: Boolean(cookies),
        headless,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
