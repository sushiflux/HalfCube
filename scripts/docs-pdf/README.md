# Document PDFs

Turns a Markdown file with front matter into a designed A4 PDF: cover in the brand colours with the logo and a
watermark, contents on its own page in two columns with page numbers, every chapter on a new page, running header and
footer, branded tables, dark code blocks, callouts, diagrams (Mermaid or hand-drawn HTML boxes) and numbered figures.
Fonts (Geist and Geist Mono, SIL Open Font License, see `fonts/OFL-LICENSE.txt`) are embedded.

The PDF is printed by a **hidden Electron window** (`show: false`): no window appears, nothing takes the focus, and
the page has no network access. The Electron runtime comes from the repository's own `node_modules` (or from the
environment variable `HALFCUBE_ELECTRON_EXE`).

## Use

```
npm ci --prefix scripts/docs-pdf                       once (Markdown, diagram and PDF-reader libraries)
node scripts/docs-pdf/build.mjs <input.md> <output.pdf> [--version-file <path>] [--channel <name>] [--html <path>]
node scripts/docs-pdf/build-docs.mjs [--out-dir <folder>] [--channel <name>]     the four manuals of docs/
node scripts/docs-pdf/preview.mjs <file.pdf> <outDir> [pages] [scale]            pages as PNG, for looking at them
```

`pages` is a list such as `1,2,5-7` or `all`. `--channel` (or `HALFCUBE_CHANNEL`) adds the channel symbol to the
version, like the program does; without it the version has none.

## Front matter

```
---
title: "HalfCube"          brand name in the running header
subtitle: "Handbuch"        large title on the cover
tagline: "..."              optional line under the title
status: "Entwurf"
classification: "Intern"    optional; also the kicker pill on the cover
copyright: "© 2026 SushiFlux"
lang: "de"                  de or en: fixed labels, callout names, figure captions
version: ...                optional, see below
date: ...                   optional, see below
toc-depth: 2                optional, 1 = chapters only
---
```

When `version` or `date` is missing, the build takes the version from the **second line of `version.txt`** and the date
from the commit date of that file (its modification date when git is not available). No version is written into the
Markdown files.

## Markdown

- Chapters are `# 1 Title` (large number), sections `## 1.1 Title`, `### 1.1.1 Title`.
- Callouts: `> [!HINWEIS]`, `[!TIPP]`, `[!WARNUNG]`, `[!OFFEN]`, `[!ENTSCHEIDUNG]`; English `NOTE`, `TIP`, `WARNING`,
  `OPEN`, `DECISION`.
- Diagrams: a fenced block with the language `mermaid`, or raw HTML boxes with the class `diagram`.
- Figures: an image alone in its paragraph, `![Caption title](images/x.png)`. It is numbered ("Abbildung 1:" /
  "Figure 1:") and shown at half its pixel width (screenshots are taken at device scale 2); the title `"1x"` marks an
  image taken at scale 1. A missing image stops the build.

## Look

`theme.json` holds the colours (theme "Präzision"), the wordmark rules and the font files. The brand name comes from
`../../branding/branding.json`, the logo from `../../branding/source/logo-square.png`; the logo is shown as it is,
never redrawn.

## Files

| File | Job |
|---|---|
| `build.mjs`, `build-docs.mjs` | command line, version and date, HTML assembly, starting Electron |
| `render.mjs` | Markdown to HTML and the style sheet |
| `print.cjs` | Electron job: load the page, draw the diagrams, print twice (the second time with page numbers) |
| `pdfjs-host.cjs`, `pdf-to-png.cjs`, `preview.mjs` | read a PDF with pdf.js (page of every heading, pages as PNG) |
| `bootstrap.cjs`, `run-electron.mjs` | start Electron without any error dialog, wait for it, end it when it hangs |
