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

## Local Playwright inspector

```sh
./inspect-local.js http://127.0.0.1:8000/ --print-metrics
./inspect-local.js --scenario .codex-scenarios/theme-editor.json
./inspect-local.js --scenario-json '{"checks":[{"type":"count","selector":"main","equals":1}]}'
```

`inspect-local.js` is a flexible, local-only Playwright runner for inspecting
the hpp watcher site. It refuses non-loopback URLs and writes screenshots only
under `.codex-screenshots/`. Scenario JSON can run actions such as normal and
shadow-DOM clicks, fills, selects, details expansion, page evaluation,
assertions, and screenshots.

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

## TeX to SVG

```sh
./tex-to-svg.py site/images/figure.tex
./tex-to-svg.py site/images/figure.tex -o site/images/figure.svg
./tex-to-svg.py --code '\begin{tikzpicture}\draw (0,0) circle (1);\end{tikzpicture}' -o site/images/circle.svg
./tex-to-svg.py --mode math --code '\int_0^1 x^2\,dx' -o site/images/integral.svg
```

The tool runs `latex` to produce DVI, then `dvisvgm` to produce SVG. File inputs
compile from the source file's directory so relative `\input{...}` paths behave
the same as local LaTeX builds. Direct `--code` and `--stdin` input are wrapped
in a small `standalone` document unless `--mode document` is used or
`\documentclass` is detected. PGF/TikZ sources use PGF's `dvisvgm` driver by
default so common figures do not require Ghostscript; pass
`--no-pgf-dvisvgm-driver` for sources that choose their own driver.
