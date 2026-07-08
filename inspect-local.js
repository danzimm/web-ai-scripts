#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function usage() {
  console.log(`Usage: inspect-local.js [URL] [options]

Runs a local-only Playwright inspection against the hpp watcher site.

Arguments:
  URL                         Local page URL (default: http://127.0.0.1:8000/)

Options:
  --scenario FILE             JSON scenario with actions, assertions, and screenshots
  --scenario-json JSON        Inline JSON scenario string
  --out FILE                  Screenshot path under .codex-screenshots/
  --width NUMBER              Viewport width (default: 1440)
  --height NUMBER             Viewport height (default: 1000)
  --color-scheme light|dark   Emulated color scheme (default: light)
  --wait-until STATE          load, domcontentloaded, or networkidle (default: networkidle)
  --timeout NUMBER            Navigation timeout in ms (default: 30000)
  --scroll-y NUMBER           Scroll before capture or actions (default: 0)
  --viewport-only             Capture only the viewport
  --disable-javascript        Disable JavaScript before loading the page
  --print-metrics             Print viewport metrics and horizontal overflow
  --print-console             Print browser console messages
  --box-selector SELECTOR     Print boxes for selector (repeatable)
  --eval FILE                 Evaluate a JS file in the page context and print the result
  -h, --help                  Show this help

Scenario shape:
  {
    "url": "http://127.0.0.1:8000/",
    "viewport": { "width": 1440, "height": 1000 },
    "actions": [
      { "type": "clearLocalStorage" },
      { "type": "click", "selector": "button" },
      { "type": "shadowClick", "host": "#hpp-variable-editor", "selector": "[data-tab=layout]" },
      { "type": "shadowOpenDetails", "host": "#hpp-variable-editor", "label": "--color-accent" },
      { "type": "evaluate", "script": "return document.title;" },
      { "type": "screenshot", "path": ".codex-screenshots/open-card.png", "viewportOnly": true }
    ],
    "checks": [
      { "type": "count", "selector": "main", "equals": 1 },
      { "type": "shadowCount", "host": "#hpp-variable-editor", "selector": ".color-card", "min": 1 }
    ]
  }

Environment:
  PLAYWRIGHT_REQUIRE          Module name or absolute path to require for Playwright
`);
}

function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_REQUIRE,
    'playwright',
    '/Applications/Codex.app/Contents/Resources/cua_node/lib/node_modules/playwright',
  ].filter(Boolean);

  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate).chromium;
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }

  throw new Error(`Could not load Playwright. Tried:\n${errors.join('\n')}`);
}

function parseArgs(argv) {
  const valueOptions = new Set([
    '--scenario',
    '--scenario-json',
    '--out',
    '--width',
    '--height',
    '--color-scheme',
    '--wait-until',
    '--timeout',
    '--scroll-y',
    '--box-selector',
    '--eval',
  ]);
  const flagOptions = new Set([
    '--viewport-only',
    '--disable-javascript',
    '--print-metrics',
    '--print-console',
    '--help',
    '-h',
  ]);
  const options = new Map();
  const flags = new Set();
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueOptions.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      if (!options.has(arg)) {
        options.set(arg, []);
      }
      options.get(arg).push(value);
      index += 1;
    } else if (flagOptions.has(arg)) {
      flags.add(arg);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return { flags, options, positionals };
}

function optionValue(parsed, name, fallback) {
  const values = parsed.options.get(name);
  return values && values.length > 0 ? values[values.length - 1] : fallback;
}

function optionValues(parsed, name) {
  return parsed.options.get(name) || [];
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function assertLocalUrl(rawUrl) {
  const url = new URL(rawUrl);
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
  if (!['http:', 'https:'].includes(url.protocol) || !localHosts.has(url.hostname)) {
    throw new Error(`Refusing non-local URL: ${rawUrl}`);
  }
  return url.toString();
}

function assertScreenshotPath(outputPath) {
  const resolved = path.resolve(outputPath);
  const screenshotsRoot = path.resolve('.codex-screenshots');
  if (resolved !== screenshotsRoot && !resolved.startsWith(`${screenshotsRoot}${path.sep}`)) {
    throw new Error(`Screenshot output must be under .codex-screenshots/: ${outputPath}`);
  }
  return resolved;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function valueFromScenario(scenario, pathParts, fallback) {
  let value = scenario;
  for (const part of pathParts) {
    if (!value || value[part] === undefined) {
      return fallback;
    }
    value = value[part];
  }
  return value;
}

async function shadowRootHandle(page, hostSelector) {
  const host = await page.$(hostSelector);
  if (!host) {
    throw new Error(`Missing shadow host: ${hostSelector}`);
  }
  const shadow = await host.evaluateHandle((element) => element.shadowRoot);
  const value = await shadow.jsonValue().catch(() => null);
  if (value === null) {
    throw new Error(`Host has no open shadow root: ${hostSelector}`);
  }
  return shadow;
}

async function shadowElementHandle(page, hostSelector, selector) {
  const shadow = await shadowRootHandle(page, hostSelector);
  const element = await shadow.evaluateHandle((root, innerSelector) => root.querySelector(innerSelector), selector);
  const value = await element.jsonValue().catch(() => null);
  if (value === null) {
    throw new Error(`Missing shadow element: ${hostSelector} ${selector}`);
  }
  return element;
}

async function evaluateScript(page, source, arg = undefined) {
  const fn = new Function('arg', source);
  return page.evaluate(fn, arg);
}

async function collectMetrics(page, boxSelectors = []) {
  return page.evaluate((selectors) => {
    const rectFor = (element) => {
      const bounds = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        className: typeof element.className === 'string' && element.className ? element.className : null,
        x: Math.round(bounds.x),
        y: Math.round(bounds.y + window.scrollY),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        left: Math.round(bounds.left),
        right: Math.round(bounds.right),
      };
    };
    return {
      url: location.href,
      innerWidth,
      innerHeight,
      documentElementClientWidth: document.documentElement.clientWidth,
      documentElementClientHeight: document.documentElement.clientHeight,
      documentElementScrollWidth: document.documentElement.scrollWidth,
      documentElementScrollHeight: document.documentElement.scrollHeight,
      bodyClientWidth: document.body.clientWidth,
      bodyClientHeight: document.body.clientHeight,
      bodyScrollWidth: document.body.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      viewportOverflowingElements: Array.from(document.querySelectorAll('body *'))
        .map(rectFor)
        .filter((element) => element.width > 0 && (element.left < 0 || element.right > innerWidth))
        .slice(0, 20),
      boxes: selectors.flatMap((selector) => (
        Array.from(document.querySelectorAll(selector)).map((element, index) => ({
          selector,
          index,
          ...rectFor(element),
        }))
      )),
    };
  }, boxSelectors);
}

async function runAction(page, action, options) {
  if (!action || typeof action !== 'object') {
    throw new Error(`Invalid action: ${JSON.stringify(action)}`);
  }
  switch (action.type) {
    case 'clearLocalStorage':
      await page.evaluate(() => localStorage.clear());
      return null;
    case 'reload':
      await page.reload({ waitUntil: action.waitUntil || options.waitUntil, timeout: options.timeout });
      return null;
    case 'wait':
      await page.waitForTimeout(nonNegativeNumber(action.ms ?? 250, 'action.ms'));
      return null;
    case 'waitForSelector':
      await page.waitForSelector(action.selector, { timeout: action.timeout || options.timeout });
      return null;
    case 'click':
      await page.click(action.selector, { timeout: action.timeout || options.timeout });
      return null;
    case 'fill':
      await page.fill(action.selector, String(action.value ?? ''), { timeout: action.timeout || options.timeout });
      return null;
    case 'select':
      await page.selectOption(action.selector, String(action.value ?? ''), { timeout: action.timeout || options.timeout });
      return null;
    case 'setChecked':
      await page.setChecked(action.selector, Boolean(action.checked), { timeout: action.timeout || options.timeout });
      return null;
    case 'scroll':
      await page.evaluate((y) => window.scrollTo(0, y), nonNegativeNumber(action.y ?? 0, 'action.y'));
      return null;
    case 'shadowClick': {
      const element = await shadowElementHandle(page, action.host, action.selector);
      await element.evaluate((node) => node.click());
      return null;
    }
    case 'shadowFill': {
      const element = await shadowElementHandle(page, action.host, action.selector);
      await element.evaluate((node, value) => {
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
      }, String(action.value ?? ''));
      return null;
    }
    case 'shadowSelect': {
      const element = await shadowElementHandle(page, action.host, action.selector);
      await element.evaluate((node, value) => {
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }, String(action.value ?? ''));
      return null;
    }
    case 'shadowSetOpen': {
      const element = await shadowElementHandle(page, action.host, action.selector);
      await element.evaluate((node, open) => {
        node.open = open;
      }, action.open !== false);
      return null;
    }
    case 'shadowOpenDetails':
      await page.evaluate(({ hostSelector, labelText }) => {
        const shadow = document.querySelector(hostSelector)?.shadowRoot;
        if (!shadow) throw new Error(`Missing shadow host: ${hostSelector}`);
        const details = Array.from(shadow.querySelectorAll('details')).find((node) => (
          Array.from(node.querySelectorAll('label, .variable-name')).some((label) => label.textContent === labelText)
        ));
        if (!details) throw new Error(`Missing details for label: ${labelText}`);
        details.open = true;
      }, { hostSelector: action.host, labelText: action.label });
      return null;
    case 'evaluate':
      return evaluateScript(page, action.script, action.arg);
    case 'screenshot': {
      const out = assertScreenshotPath(action.path || options.out);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await page.screenshot({ path: out, fullPage: action.viewportOnly === undefined ? !options.viewportOnly : !action.viewportOnly });
      return { screenshot: path.relative(process.cwd(), out) };
    }
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

async function runCheck(page, check, options) {
  const fail = (message) => {
    throw new Error(`Check failed (${check.type}): ${message}`);
  };
  const compareCount = (count) => {
    if (check.equals !== undefined && count !== check.equals) fail(`${count} !== ${check.equals}`);
    if (check.min !== undefined && count < check.min) fail(`${count} < ${check.min}`);
    if (check.max !== undefined && count > check.max) fail(`${count} > ${check.max}`);
    return count;
  };
  switch (check.type) {
    case 'count': {
      const count = await page.locator(check.selector).count();
      return { ...check, count: compareCount(count) };
    }
    case 'shadowCount': {
      const count = await page.evaluate(({ hostSelector, selector }) => {
        const shadow = document.querySelector(hostSelector)?.shadowRoot;
        if (!shadow) throw new Error(`Missing shadow host: ${hostSelector}`);
        return shadow.querySelectorAll(selector).length;
      }, { hostSelector: check.host, selector: check.selector });
      return { ...check, count: compareCount(count) };
    }
    case 'textIncludes': {
      const text = await page.locator(check.selector).innerText({ timeout: check.timeout || options.timeout });
      if (!text.includes(check.text)) fail(`text does not include ${JSON.stringify(check.text)}`);
      return { ...check, matched: true };
    }
    case 'evaluate': {
      const result = await evaluateScript(page, check.script, check.arg);
      if (check.equals !== undefined && result !== check.equals) fail(`${JSON.stringify(result)} !== ${JSON.stringify(check.equals)}`);
      if (check.truthy && !result) fail(`${JSON.stringify(result)} is not truthy`);
      return { ...check, result };
    }
    default:
      throw new Error(`Unknown check type: ${check.type}`);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.has('--help') || parsed.flags.has('-h')) {
    usage();
    return;
  }

  const scenarioPath = optionValue(parsed, '--scenario', null);
  const scenarioJson = optionValue(parsed, '--scenario-json', null);
  if (scenarioPath && scenarioJson) {
    throw new Error('Use only one of --scenario or --scenario-json');
  }
  const scenario = scenarioPath ? readJson(scenarioPath) : scenarioJson ? JSON.parse(scenarioJson) : {};
  const url = assertLocalUrl(valueFromScenario(scenario, ['url'], parsed.positionals[0] || 'http://127.0.0.1:8000/'));
  const width = positiveInteger(valueFromScenario(scenario, ['viewport', 'width'], optionValue(parsed, '--width', '1440')), 'width');
  const height = positiveInteger(valueFromScenario(scenario, ['viewport', 'height'], optionValue(parsed, '--height', '1000')), 'height');
  const colorScheme = valueFromScenario(scenario, ['colorScheme'], optionValue(parsed, '--color-scheme', 'light'));
  const waitUntil = valueFromScenario(scenario, ['waitUntil'], optionValue(parsed, '--wait-until', 'networkidle'));
  const timeout = positiveInteger(valueFromScenario(scenario, ['timeout'], optionValue(parsed, '--timeout', '30000')), 'timeout');
  const scrollY = nonNegativeNumber(valueFromScenario(scenario, ['scrollY'], optionValue(parsed, '--scroll-y', '0')), 'scrollY');
  const viewportOnly = scenario.viewportOnly ?? parsed.flags.has('--viewport-only');
  const out = scenario.out || optionValue(parsed, '--out', null);
  const javaScriptEnabled = !(scenario.disableJavaScript ?? parsed.flags.has('--disable-javascript'));
  const boxSelectors = [...optionValues(parsed, '--box-selector'), ...(scenario.boxSelectors || [])];

  if (!['light', 'dark'].includes(colorScheme)) {
    throw new Error('--color-scheme must be light or dark');
  }
  if (!['load', 'domcontentloaded', 'networkidle'].includes(waitUntil)) {
    throw new Error('--wait-until must be load, domcontentloaded, or networkidle');
  }

  const consoleMessages = [];
  const pageErrors = [];
  const chromium = loadChromium();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme,
    javaScriptEnabled,
  });

  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => {
    pageErrors.push(String(error));
  });

  await page.goto(url, { waitUntil, timeout });
  if (scrollY > 0) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(100);
  }

  const evalFiles = optionValues(parsed, '--eval');
  const results = [];
  for (const file of evalFiles) {
    results.push({ eval: file, result: await evaluateScript(page, fs.readFileSync(file, 'utf8')) });
  }
  for (const action of scenario.actions || []) {
    const result = await runAction(page, action, { waitUntil, timeout, out, viewportOnly });
    if (result !== null && result !== undefined) {
      results.push({ action: action.type, result });
    }
  }

  const checks = [];
  for (const check of scenario.checks || []) {
    checks.push(await runCheck(page, check, { timeout }));
  }

  if (out) {
    const screenshotPath = assertScreenshotPath(out);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: !viewportOnly });
    results.push({ screenshot: path.relative(process.cwd(), screenshotPath) });
  }

  const metrics = (parsed.flags.has('--print-metrics') || scenario.printMetrics || boxSelectors.length > 0)
    ? await collectMetrics(page, boxSelectors)
    : null;

  await browser.close();

  const output = {
    url,
    viewport: { width, height },
    results,
    checks,
    metrics,
    console: (parsed.flags.has('--print-console') || scenario.printConsole) ? consoleMessages : undefined,
    pageErrors,
  };
  console.log(JSON.stringify(output, null, 2));
  if (pageErrors.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
