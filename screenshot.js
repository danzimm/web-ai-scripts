#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

function usage() {
  console.log(`Usage: screenshot.js [URL] [OUTPUT] [options]

Captures a web page screenshot with Playwright.

Arguments:
  URL                         Page URL (default: http://127.0.0.1:8000)
  OUTPUT                      PNG path (default: .codex-screenshots/page.png)

Options:
  --width NUMBER              Viewport width (default: 1440)
  --height NUMBER             Viewport height (default: 1000)
  --device-scale-factor NUM   Device scale factor (default: 1)
  --color-scheme light|dark   Emulated color scheme (default: light)
  --scroll-y NUMBER           Scroll before capture (default: 0)
  --wait-until STATE          load, domcontentloaded, or networkidle (default: networkidle)
  --timeout NUMBER            Navigation timeout in ms (default: 30000)
  --viewport-only             Capture only the viewport
  --disable-javascript        Disable JavaScript before loading the page
  --print-metrics             Print viewport and document metrics as JSON
  --print-boxes               Print element boxes as JSON
  --box-selector SELECTOR     Selector used by --print-boxes (repeatable, default: body)
  -h, --help                  Show this help

Environment:
  PLAYWRIGHT_REQUIRE          Module name or absolute path to require for Playwright
  CODEX_SCREENSHOT_NODE       Node binary used by screenshot-codex.sh
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
    '--width',
    '--height',
    '--device-scale-factor',
    '--color-scheme',
    '--scroll-y',
    '--wait-until',
    '--timeout',
    '--box-selector',
  ]);
  const flagOptions = new Set([
    '--viewport-only',
    '--disable-javascript',
    '--print-metrics',
    '--print-boxes',
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

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.has('--help') || parsed.flags.has('-h')) {
    usage();
    return;
  }

  const url = parsed.positionals[0] || 'http://127.0.0.1:8000';
  const out = parsed.positionals[1] || '.codex-screenshots/page.png';
  const width = positiveInteger(optionValue(parsed, '--width', '1440'), '--width');
  const height = positiveInteger(optionValue(parsed, '--height', '1000'), '--height');
  const deviceScaleFactor = nonNegativeNumber(optionValue(parsed, '--device-scale-factor', '1'), '--device-scale-factor');
  const colorScheme = optionValue(parsed, '--color-scheme', 'light');
  const scrollY = nonNegativeNumber(optionValue(parsed, '--scroll-y', '0'), '--scroll-y');
  const waitUntil = optionValue(parsed, '--wait-until', 'networkidle');
  const timeout = positiveInteger(optionValue(parsed, '--timeout', '30000'), '--timeout');
  const printBoxes = parsed.flags.has('--print-boxes');
  const printMetrics = parsed.flags.has('--print-metrics');
  const viewportOnly = parsed.flags.has('--viewport-only');
  const javaScriptEnabled = !parsed.flags.has('--disable-javascript');
  const boxSelectors = optionValues(parsed, '--box-selector');

  if (!['light', 'dark'].includes(colorScheme)) {
    throw new Error('--color-scheme must be light or dark');
  }
  if (!['load', 'domcontentloaded', 'networkidle'].includes(waitUntil)) {
    throw new Error('--wait-until must be load, domcontentloaded, or networkidle');
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });

  const chromium = loadChromium();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor,
    colorScheme,
    javaScriptEnabled,
  });

  await page.goto(url, { waitUntil, timeout });
  if (scrollY > 0) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(100);
  }
  if (printMetrics) {
    const metrics = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentElementClientWidth: document.documentElement.clientWidth,
      documentElementClientHeight: document.documentElement.clientHeight,
      documentElementScrollWidth: document.documentElement.scrollWidth,
      documentElementScrollHeight: document.documentElement.scrollHeight,
      bodyClientWidth: document.body.clientWidth,
      bodyClientHeight: document.body.clientHeight,
      bodyScrollWidth: document.body.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      viewportOverflowingElements: Array.from(document.querySelectorAll('body *'))
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            selector: [
              element.tagName.toLowerCase(),
              element.id ? `#${element.id}` : '',
              element.className && typeof element.className === 'string'
                ? `.${element.className.trim().split(/\s+/).join('.')}`
                : '',
            ].join(''),
            left: Math.round(bounds.left),
            right: Math.round(bounds.right),
            width: Math.round(bounds.width),
          };
        })
        .filter((element) => element.left < 0 || element.right > window.innerWidth)
        .slice(0, 20),
    }));
    console.log(JSON.stringify(metrics));
  }
  if (printBoxes) {
    const selectors = boxSelectors.length > 0 ? boxSelectors : ['body'];
    const boxes = await page.evaluate((selectorsToMeasure) => (
      selectorsToMeasure.flatMap((selector) => (
        Array.from(document.querySelectorAll(selector)).map((element, index) => {
          const bounds = element.getBoundingClientRect();
          return {
            selector,
            index,
            tagName: element.tagName.toLowerCase(),
            id: element.id || null,
            className: typeof element.className === 'string' && element.className ? element.className : null,
            x: Math.round(bounds.x),
            y: Math.round(bounds.y + window.scrollY),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          };
        })
      ))
    ), selectors);
    console.log(JSON.stringify(boxes));
  }
  await page.screenshot({ path: out, fullPage: !viewportOnly });
  await browser.close();

  console.log(`Wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
