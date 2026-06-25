# web-ai-scripts

Small web automation and image-processing helpers used from local repos.

## Screenshot helper

```sh
./screenshot-codex.sh http://127.0.0.1:8000 .codex-screenshots/home.png
```

The wrapper uses Codex's bundled Node runtime when it is available, then falls
back to `node` on `PATH`. `screenshot.js` resolves Playwright from
`PLAYWRIGHT_REQUIRE`, from normal Node resolution, or from Codex's bundled
Playwright install.

Useful options:

```sh
./screenshot-codex.sh URL OUT --width 390 --height 844 --viewport-only
./screenshot-codex.sh URL OUT --disable-javascript
./screenshot-codex.sh URL OUT --print-boxes --box-selector main
./screenshot-codex.sh URL OUT --print-metrics
```

## PNG color tools

```sh
node png-color-tools.js chart-dark input.png output.png
node png-color-tools.js disks-dark input.png output.png
node png-color-tools.js key-background input.png output.png --target '#383b3c' --radius 24
```

The PNG tool supports 8-bit, non-interlaced RGB/RGBA PNGs and does not require
third-party packages.

## Glyph measurement

```sh
swift measure-logo-glyphs.swift --image screenshot.png --region logo:80,120,260,190
```

Regions are image pixel coordinates in `x0,y0,x1,y1` form. When no region is
provided, the script measures the whole image.
