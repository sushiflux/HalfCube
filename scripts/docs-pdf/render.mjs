// Turns a Markdown document with front matter into the HTML that print.cjs prints as an A4 PDF.
// Front matter (--- key: value ---): title, subtitle, tagline, version, date, status, classification, copyright, lang.
// Without "version" and "date" the build takes them from version.txt (see build.mjs).
// Chapters are "# 1 Title", sections "## 1.1 Title". Callouts: "> [!HINWEIS] ...", [!TIPP], [!WARNUNG], [!OFFEN],
// [!ENTSCHEIDUNG] (English: NOTE, TIP, WARNING, OPEN, DECISION). Diagrams: ```mermaid blocks or raw HTML boxes
// (class "diagram"). Figures: an image alone in its paragraph, ![Caption title](bilder/x.png), becomes a numbered
// figure ("Abbildung 1: ..." / "Figure 1: ..."); PNG files are shown at half their pixel width (taken at scale 2), a
// title of "1x" marks an image taken at scale 1. A missing image file stops the build.
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Marked } from "marked";

export const escapeHtml = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const cssString = (text) =>
  `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;

/** Splits "---\nkey: value\n---\n" off the Markdown text. */
export function parseFrontMatter(source) {
  const text = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const meta = {};
  if (!match) return { meta, body: text };
  for (const line of match[1].split("\n")) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    let value = pair[2].trim();
    if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    meta[pair[1]] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

const ICONS = {
  note: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
  tip: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.4 1 2.5h6c0-1.1.3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  warn: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  open: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  decision: '<path d="M5 12l5 5L20 7"/>',
};
const icon = (name) =>
  `<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

const CALLOUT_KEYS = {
  HINWEIS: "note", NOTE: "note",
  TIPP: "tip", TIP: "tip",
  WARNUNG: "warn", WARNING: "warn",
  OFFEN: "open", OPEN: "open",
  ENTSCHEIDUNG: "decision", DECISION: "decision",
};
const CALLOUT_LABELS = {
  de: { note: "Hinweis", tip: "Tipp", warn: "Warnung", open: "Offen", decision: "Entscheidung" },
  en: { note: "Note", tip: "Tip", warn: "Warning", open: "Open", decision: "Decision" },
};

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp",
};

const dataUri = (file, mime) => `data:${mime};base64,${readFileSync(file).toString("base64")}`;

/** Converts the Markdown body to HTML and collects the table of contents. */
function renderBody(body, { sourceDir, en }) {
  const toc = [];
  const used = new Set();
  let figureNo = 0;
  let hasMermaid = false;
  const figureLabel = en ? "Figure" : "Abbildung";
  const labels = CALLOUT_LABELS[en ? "en" : "de"];

  const slugify = (text) => {
    let slug =
      text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
      "kapitel";
    while (used.has(slug)) slug += "-x";
    used.add(slug);
    return slug;
  };

  const embedImage = (href, title) => {
    if (/^(https?:|data:)/i.test(href)) return { src: href, style: "" };
    const file = resolve(sourceDir, decodeURI(href));
    if (!existsSync(file)) throw new Error(`Bild nicht gefunden: ${href} (gesucht unter ${file})`);
    const ext = extname(file).toLowerCase();
    const data = readFileSync(file);
    const scale = title && /\b1x\b/i.test(title) ? 1 : 2;
    const width = ext === ".png" && data.length > 24 ? data.readUInt32BE(16) / scale : 0;
    return {
      src: `data:${MIME[ext] ?? "application/octet-stream"};base64,${data.toString("base64")}`,
      style: width ? ` style="width: ${width}px"` : "",
    };
  };

  const marked = new Marked({
    renderer: {
      heading(token) {
        const id = slugify(token.text);
        const html = this.parser.parseInline(token.tokens);
        if (token.depth === 1) {
          const numbered = /^(\d+)\s+(.*)$/.exec(token.text);
          const title = numbered ? html.slice(numbered[1].length).trim() : html;
          const number = numbered ? numbered[1].padStart(2, "0") : "";
          toc.push({ level: 1, id, number, title });
          return `<h1 id="${id}" class="chapter">${number ? `<span class="chapter-no">${number}</span>` : ""}<span class="chapter-title">${title}</span></h1>\n`;
        }
        const numbered = /^(\d+(?:\.\d+)+)\s+(.*)$/.exec(token.text);
        const title = numbered ? html.slice(numbered[1].length).trim() : html;
        if (token.depth === 2) toc.push({ level: 2, id, number: numbered ? numbered[1] : "", title });
        const number = numbered ? `<span class="section-no">${numbered[1]}</span> ` : "";
        return `<h${token.depth} id="${id}">${number}${title}</h${token.depth}>\n`;
      },
      paragraph(token) {
        const parts = token.tokens.filter((t) => !(t.type === "text" && !t.text.trim()));
        if (parts.length === 1 && parts[0].type === "image") {
          const image = parts[0];
          const { src, style } = embedImage(image.href, image.title);
          figureNo += 1;
          return `<figure class="figure" id="figure-${figureNo}"><img src="${src}" alt="${escapeHtml(image.text)}"${style}><figcaption><span class="fig-no">${figureLabel} ${figureNo}:</span> ${escapeHtml(image.text)}</figcaption></figure>\n`;
        }
        return `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
      },
      image(token) {
        const { src, style } = embedImage(token.href, token.title);
        return `<img src="${src}" alt="${escapeHtml(token.text)}"${style}>`;
      },
      code(token) {
        if ((token.lang ?? "").trim().toLowerCase() === "mermaid") {
          hasMermaid = true;
          return `<figure class="mermaid-fig"><script type="text/plain" class="mermaid-src">${token.text.replace(/<\/script/gi, "<\\/script")}</script><div class="mermaid-out"></div></figure>\n`;
        }
        const lang = (token.lang ?? "").trim().split(/\s+/)[0];
        return `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(token.text)}</code></pre>\n`;
      },
      blockquote(token) {
        const marker = /^\s*\[!(\w+)\]\s*/.exec(token.text);
        const kind = marker ? CALLOUT_KEYS[marker[1].toUpperCase()] : undefined;
        let inner = this.parser.parse(token.tokens);
        if (!kind) return `<blockquote>${inner}</blockquote>\n`;
        inner = inner.replace(/\[!\w+\]\s*/, "");
        return `<blockquote class="callout ${kind}"><div class="callout-head">${icon(kind)}<span>${labels[kind]}</span></div>${inner}</blockquote>\n`;
      },
    },
  });
  const html = marked.parse(body, { async: false });
  return { html, toc, hasMermaid };
}

/** Font size of the brand line on the cover (logo and wordmark), in pt. 21 pt = 28 px, so the large wordmark is used. */
const COVER_BRAND_PT = 21;

/**
 * The wordmark: the letter outlines of branding/wordmark (the same files the README and the program draw from, made by
 * scripts/make-wordmark.mjs), inlined as SVG so no font setting (such as the stylistic set of the body text) can change
 * them. `mode` is the background it sits on ("light" or "dark": the file with the matching brand colours); `fontPx` is the
 * font size it stands for, which picks the small file below `theme.wordmark.smallBelowPx` and the large one from there on,
 * like the program does. The size is given in em of the surrounding font size (the files have 1000 units per em).
 */
function wordmark({ theme, themeDir, brandName, brandSlug }, mode, fontPx) {
  const small = fontPx < theme.wordmark.smallBelowPx;
  const file = resolve(themeDir, theme.wordmark.dir, `${brandSlug}-wordmark-${mode}${small ? "-small" : ""}.svg`);
  if (!existsSync(file)) throw new Error(`Die Wortmarke fehlt: ${file} (erzeugen mit: node scripts/make-wordmark.mjs)`);
  const svg = readFileSync(file, "utf8");
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!box) throw new Error(`Die Wortmarke hat keine viewBox: ${file}`);
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>[^<]*<\/title>/, "");
  const [width, height] = [Number(box[1]) / 1000, Number(box[2]) / 1000];
  return `<svg class="wm" role="img" aria-label="${escapeHtml(brandName)}" viewBox="0 0 ${box[1]} ${box[2]}" style="width: ${width}em; height: ${height}em">${inner}</svg>`;
}

function css({ theme, docName, footerLabel, fontUrls }) {
  const c = theme.colors;
  return `
@font-face { font-family: '${theme.fonts.sans.family}'; src: url("${fontUrls.sans}") format('woff2'); font-weight: 100 900; font-style: normal; }
@font-face { font-family: '${theme.fonts.mono.family}'; src: url("${fontUrls.mono}") format('woff2'); font-weight: 100 900; font-style: normal; }
:root {
  --ink: ${c.ink}; --ink-2: ${c.ink2}; --muted: ${c.muted}; --line: ${c.line}; --soft: ${c.soft};
  --navy: ${c.navy}; --blue: ${c.blue}; --cyan: ${c.cyan}; --teal: ${c.teal}; --accent-soft: ${c.accentSoft};
  --note: ${c.note}; --note-soft: ${c.noteSoft}; --tip: ${c.tip}; --tip-soft: ${c.tipSoft};
  --warn: ${c.warn}; --warn-soft: ${c.warnSoft}; --open: ${c.open}; --open-soft: ${c.openSoft};
  --decision: ${c.decision}; --decision-soft: ${c.decisionSoft};
  --sans: '${theme.fonts.sans.family}', 'Segoe UI', system-ui, sans-serif;
  --mono: '${theme.fonts.mono.family}', 'Cascadia Mono', Consolas, monospace;
}
@page { size: A4; margin: 22mm 18mm 20mm 18mm;
  @top-right { content: ${cssString(docName)}; font: 600 7pt var(--sans); color: #8794a1; letter-spacing: 0.08em; text-transform: uppercase; }
  @bottom-left { content: ${cssString(footerLabel)}; font: 7.5pt var(--sans); color: ${c.muted}; }
  @bottom-right { content: counter(page) " / " counter(pages); font: 600 7.5pt var(--sans); color: ${c.blue}; } }
@page cover { margin: 0; @top-right { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: var(--sans); font-size: 9.6pt; line-height: 1.6; color: var(--ink);
  font-feature-settings: "ss01"; hyphens: manual; }
strong, b { font-weight: 650; }
.wm { display: block; flex: none; }

/* ---------- Cover ---------- */
.cover { page: cover; width: 210mm; height: 296.5mm; break-after: page; position: relative; overflow: hidden;
  background:
    radial-gradient(85% 55% at 92% 2%, rgba(76, 209, 224, 0.30) 0%, rgba(76, 209, 224, 0) 62%),
    radial-gradient(70% 48% at 0% 100%, rgba(31, 117, 174, 0.50) 0%, rgba(31, 117, 174, 0) 62%),
    linear-gradient(165deg, ${c.coverBg2} 0%, ${c.coverBg} 68%);
  color: #dbe6ee; display: flex; flex-direction: column; justify-content: space-between; padding: 26mm 22mm 16mm; }
.cover-watermark { position: absolute; right: -22mm; bottom: 30mm; width: 150mm; height: 150mm; opacity: 0.085; transform: rotate(-8deg); }
.cover-watermark img { width: 100%; height: 100%; }
.cover-brand { position: relative; display: flex; align-items: center; gap: 4mm; font-size: ${COVER_BRAND_PT}pt; }
.cover-logo { width: 15mm; height: 15mm; }
.cover-main { position: relative; }
.cover-kicker { display: inline-block; margin: 0 0 5mm; padding: 1.4mm 3.2mm; border: 1px solid rgba(76, 209, 224, 0.6); border-radius: 999px;
  font-size: 7.8pt; font-weight: 650; letter-spacing: 0.28em; text-transform: uppercase; color: ${c.cyan}; background: rgba(76, 209, 224, 0.08); }
.cover-title { margin: 0 0 7mm; line-height: 1.02; font-weight: 700; letter-spacing: -0.03em; color: #fff; overflow-wrap: anywhere; }
.cover-rule { width: 46mm; height: 3px; margin: 0 0 7mm; border-radius: 3px; background: linear-gradient(90deg, ${c.blue}, ${c.cyan}); }
.cover-tagline { max-width: 140mm; font-size: 12.5pt; line-height: 1.5; color: #c3d3de; margin: 0 0 15mm; }
.cover-meta { display: grid; gap: 4mm; max-width: 166mm; }
.cover-row strong { white-space: nowrap; }
.cover-row { padding: 3mm 3.5mm; border-radius: 6px; background: rgba(10, 31, 51, 0.55); border: 1px solid rgba(160, 190, 210, 0.22); min-width: 0; }
.cover-row span { display: block; font-size: 6.6pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.16em; color: #94abbb; }
.cover-row strong { display: block; font-size: 9.2pt; font-weight: 600; color: #fff; overflow-wrap: anywhere; }
.cover-footer { position: relative; font-size: 8pt; color: #94abbb; display: flex; justify-content: space-between;
  border-top: 1px solid rgba(160, 190, 210, 0.25); padding-top: 4mm; }
.cover-footer .heart { color: ${c.cyan}; }

/* ---------- Table of contents ---------- */
.toc { break-after: page; line-height: 1.25; }
.toc-title { font-size: 26pt; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 2mm; color: var(--navy); line-height: 1.2; }
.toc-rule { width: 30mm; height: 3px; border-radius: 3px; background: linear-gradient(90deg, var(--blue), var(--cyan)); margin-bottom: 5mm; }
.toc ol { list-style: none; margin: 0; padding: 0; columns: 2; column-gap: 12mm; }
.toc li { break-inside: avoid; }
.toc a { color: inherit; text-decoration: none; display: flex; gap: 2mm; align-items: baseline; padding: 0.15mm 0; }
.toc-text { flex: 1; min-width: 0; }
.toc-pg { min-width: 7mm; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.toc .toc-l1 { margin-top: 1.8mm; font-weight: 650; font-size: 8.6pt; border-top: 1px solid var(--line); padding-top: 0.9mm; break-after: avoid; }
.toc .toc-l1:first-child { margin-top: 0; }
.toc .toc-l1 .toc-no { min-width: 6.5mm; color: var(--blue); font-weight: 700; }
.toc .toc-l2 a { font-size: 7.1pt; line-height: 1.22; color: var(--ink-2); padding-left: 6.5mm; }
.toc .toc-l2 .toc-no { min-width: 8mm; color: var(--teal); }

/* ---------- Content ---------- */
.content h1.chapter { break-before: page; margin: 0 0 7mm; padding-bottom: 4mm; position: relative; }
.content h1.chapter::after { content: ""; position: absolute; left: 0; bottom: 0; width: 100%; height: 2px;
  background: linear-gradient(90deg, var(--blue), var(--cyan) 55%, rgba(76, 209, 224, 0)); }
.content .chapter-no { display: block; font-size: 40pt; line-height: 1; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 1mm; color: var(--blue); }
.content .chapter-no::after { content: "."; color: var(--cyan); }
.content .chapter-title { display: block; font-size: 23pt; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; color: var(--navy); }
.content h2 { font-size: 13.5pt; font-weight: 650; margin: 8mm 0 2.5mm; color: var(--navy); break-after: avoid; }
.content h2 .section-no, .content h3 .section-no { color: var(--teal); margin-right: 1.5mm; }
.content h3 { font-size: 11pt; font-weight: 650; margin: 5.5mm 0 1.5mm; color: var(--ink-2); break-after: avoid; }
.content h4 { font-size: 9.8pt; font-weight: 650; margin: 4mm 0 1mm; color: var(--ink-2); break-after: avoid; }
.content p { margin: 0 0 2.8mm; orphans: 3; widows: 3; }
.content ul, .content ol { margin: 0 0 3.2mm; padding-left: 6mm; }
.content li { margin: 0.9mm 0; }
.content li::marker { color: var(--teal); font-weight: 700; }
.content a { color: var(--blue); text-decoration: none; }
.content hr { border: 0; border-top: 1px solid var(--line); margin: 5mm 0; }
.content code { font-family: var(--mono); font-size: 8.2pt; background: var(--accent-soft); color: ${c.navy};
  border-radius: 3px; padding: 0.2mm 1.1mm; overflow-wrap: break-word; }
.content pre { font-family: var(--mono); background: ${c.codeBg}; color: ${c.codeText}; border-radius: 6px; padding: 4mm 4.5mm; font-size: 7.8pt;
  line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; border-left: 3px solid var(--cyan); }
.content pre code { background: none; color: inherit; padding: 0; font-size: inherit; }
.content table { width: 100%; border-collapse: separate; border-spacing: 0; margin: 2mm 0 4.5mm; font-size: 8.5pt; line-height: 1.45;
  border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.content thead { display: table-header-group; }
.content tr { break-inside: avoid; }
.content th { text-align: left; font-weight: 650; color: #fff; background: linear-gradient(90deg, ${c.navy}, ${c.blue}); padding: 2mm 2.6mm; }
.content td { border-top: 1px solid var(--line); padding: 1.8mm 2.6mm; vertical-align: top; overflow-wrap: anywhere; }
.content td.nowrap, .content th.nowrap { white-space: nowrap; }
.content td:first-child { overflow-wrap: break-word; }
.content tbody tr:nth-child(even) td { background: var(--soft); }
.content blockquote { margin: 3.5mm 0 4.5mm; padding: 3mm 4mm; border-left: 3px solid var(--blue); background: var(--soft);
  color: var(--ink-2); border-radius: 0 6px 6px 0; }
.content blockquote.callout { break-inside: auto; }
.content blockquote p:last-child, .content blockquote ul:last-child, .content blockquote ol:last-child { margin-bottom: 0; }
.callout-head { display: flex; align-items: center; gap: 2mm; margin-bottom: 1.2mm; font-size: 7.4pt; font-weight: 750;
  text-transform: uppercase; letter-spacing: 0.14em; }
.callout-icon { width: 13px; height: 13px; flex: none; }
.content blockquote.note { background: var(--note-soft); border-color: var(--note); } .content blockquote.note .callout-head { color: var(--note); }
.content blockquote.tip { background: var(--tip-soft); border-color: var(--tip); } .content blockquote.tip .callout-head { color: var(--tip); }
.content blockquote.warn { background: var(--warn-soft); border-color: var(--warn); } .content blockquote.warn .callout-head { color: var(--warn); }
.content blockquote.open { background: var(--open-soft); border-color: var(--open); } .content blockquote.open .callout-head { color: var(--open); }
.content blockquote.decision { background: var(--decision-soft); border-color: var(--decision); } .content blockquote.decision .callout-head { color: var(--decision); }

/* Diagrams: Mermaid output and hand-drawn HTML boxes (left: clients, middle: labelled links, right: server) */
.mermaid-fig { margin: 3mm 0 5mm; padding: 4mm; border: 1px solid var(--line); border-radius: 8px; background: linear-gradient(135deg, var(--soft), #fff);
  text-align: center; break-inside: avoid; }
.mermaid-fig svg { max-width: 100%; max-height: 215mm; height: auto; }
.diagram { display: grid; grid-template-columns: 1fr 34mm 1.15fr; gap: 4mm; align-items: stretch; margin: 2mm 0 6mm;
  padding: 5mm; border-radius: 8px; background: linear-gradient(135deg, var(--soft), var(--accent-soft)); border: 1px solid var(--line); break-inside: avoid; }
.dg-col { display: flex; flex-direction: column; gap: 4mm; justify-content: center; }
.dg-box { padding: 3mm 3.5mm; border-radius: 6px; background: #fff; border: 1px solid #c7d6e3; box-shadow: 0 2px 8px rgba(22, 71, 110, 0.08); }
.dg-box strong { display: block; font-size: 9.4pt; color: var(--navy); margin-bottom: 0.8mm; }
.dg-box span { display: block; font-size: 8pt; color: var(--ink-2); line-height: 1.45; }
.dg-box em { display: block; margin-top: 1mm; font-size: 7.6pt; font-style: normal; color: var(--teal); font-weight: 600; }
.dg-main { border-color: var(--blue); border-width: 1.5px; }
.dg-links { display: flex; flex-direction: column; justify-content: space-around; }
.dg-link { position: relative; text-align: center; padding: 2mm 0 2.6mm; }
.dg-link::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; border-radius: 2px; background: linear-gradient(90deg, var(--blue), var(--cyan)); }
.dg-link b { display: block; font-size: 8pt; color: var(--navy); }
.dg-link i { display: block; font-size: 7pt; font-style: normal; color: var(--muted); }
.dg-row { display: flex; gap: 3mm; }
.dg-ext { flex: 1; text-align: center; padding: 2mm; border-radius: 6px; font-size: 8pt; font-weight: 650; color: var(--blue);
  background: var(--accent-soft); border: 1px dashed var(--blue); }

/* Figures: the screenshot (only the part being explained) framed, with a numbered caption below */
.content img { max-width: 100%; height: auto; }
.content .figure { margin: 4mm 0 5.5mm; text-align: center; break-inside: avoid; }
.content .figure img { display: inline-block; max-width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--line);
  box-shadow: 0 4px 16px rgba(15, 29, 42, 0.10); }
.content .figure figcaption { margin-top: 2.2mm; font-size: 8.4pt; line-height: 1.4; color: var(--ink-2); }
.content .figure .fig-no { font-weight: 650; color: var(--navy); }
`;
}

/**
 * Builds the complete HTML document.
 * @param {object} options
 * @param {string} options.markdown  Markdown text with front matter
 * @param {string} options.sourceDir folder of the Markdown file (relative image paths)
 * @param {object} options.defaults  values for front matter keys that are missing (version, date)
 * @param {object} options.theme     content of theme.json
 * @param {string} options.themeDir  folder of theme.json
 * @param {string} options.brandName name from branding.json
 * @param {string} options.brandSlug slug from branding.json (names the wordmark files)
 * @param {string} options.logoFile  path of the logo PNG
 * @param {string|null} options.mermaidScript path of mermaid.min.js (used when the document has diagrams)
 */
export function buildHtml({ markdown, sourceDir, defaults, theme, themeDir, brandName, brandSlug, logoFile, mermaidScript }) {
  const { meta: fileMeta, body } = parseFrontMatter(markdown);
  const meta = { ...defaults, ...fileMeta };
  const en = (meta.lang ?? "de") === "en";
  const { html: content, toc, hasMermaid } = renderBody(body, { sourceDir, en });

  const fontUrls = {
    sans: pathToFileURL(resolve(themeDir, theme.fonts.sans.file)).href,
    mono: pathToFileURL(resolve(themeDir, theme.fonts.mono.file)).href,
  };
  const docName = [meta.title, meta.subtitle].filter(Boolean).join(" · ");
  const footerLabel = [docName, meta.version && `Version ${meta.version}`].filter(Boolean).join(" · ");

  const logoUri = dataUri(logoFile, "image/png");
  const rows = [
    ["Version", meta.version],
    [en ? "Date" : "Stand", meta.date],
    ["Status", meta.status],
    [en ? "Classification" : "Einstufung", meta.classification],
  ].filter(([, value]) => value);
  const coverRows = rows
    .map(([label, value]) => `<div class="cover-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");

  const tocDepth = Number(meta["toc-depth"] ?? 2);
  const tocHtml = toc
    .filter((e) => e.level <= tocDepth)
    .map((e) =>
      e.level === 1
        ? `<li class="toc-l1"><a href="#${e.id}">${e.number ? `<span class="toc-no">${e.number}</span>` : ""}<span class="toc-text">${e.title}</span><span class="toc-pg" data-toc-pg="${e.id}">00</span></a></li>`
        : `<li class="toc-l2"><a href="#${e.id}">${e.number ? `<span class="toc-no">${e.number}</span>` : ""}<span class="toc-text">${e.title}</span><span class="toc-pg" data-toc-pg="${e.id}">00</span></a></li>`,
    )
    .join("");

  // Cover title: the longer the words, the smaller the type, so the title always fits the line.
  const title = meta.subtitle ?? meta.title ?? "";
  const longest = Math.max(1, ...title.split(/\s+/).map((w) => w.length));
  const coverSize = Math.max(26, Math.min(50, Math.floor(470 / (longest * 0.6))));
  const kicker = meta.kicker ?? meta.classification ?? (en ? "Documentation" : "Dokumentation");

  const mermaidTags =
    hasMermaid && mermaidScript
      ? `<script src="${pathToFileURL(mermaidScript).href}"></script>\n<script>window.__mermaidTheme = ${JSON.stringify(mermaidTheme(theme))};</script>`
      : "";

  return `<!doctype html><html lang="${en ? "en" : "de"}"><head><meta charset="utf-8"><title>${escapeHtml(footerLabel)}</title><style>${css({ theme, docName, footerLabel, fontUrls })}</style></head><body>
<section class="cover">
  <div class="cover-watermark"><img src="${logoUri}" alt=""></div>
  <div class="cover-brand"><img class="cover-logo" src="${logoUri}" alt="">${wordmark({ theme, themeDir, brandName, brandSlug }, "dark", COVER_BRAND_PT * 96 / 72)}</div>
  <div class="cover-main">
    <div class="cover-kicker">${escapeHtml(kicker)}</div>
    <h1 class="cover-title" style="font-size: ${coverSize}pt">${escapeHtml(title)}</h1>
    <div class="cover-rule"></div>
    ${meta.tagline ? `<p class="cover-tagline">${escapeHtml(meta.tagline)}</p>` : ""}
    <div class="cover-meta" style="grid-template-columns: minmax(0, 1.8fr) repeat(${Math.max(0, rows.length - 1)}, minmax(0, 1fr))">${coverRows}</div>
  </div>
  <div class="cover-footer"><span>${escapeHtml(meta.copyright ?? "")}</span><span>${escapeHtml(theme.credit[en ? "en" : "de"]).replace("♥", '<span class="heart">♥</span>')}</span></div>
</section>
<nav class="toc"><h1 class="toc-title">${en ? "Contents" : "Inhalt"}</h1><div class="toc-rule"></div><ol>${tocHtml}</ol></nav>
<main class="content">${content}</main>
${mermaidTags}
<script>${PAGE_SCRIPT}</script>
</body></html>`;
}

function mermaidTheme(theme) {
  const c = theme.colors;
  return {
    theme: "base",
    themeVariables: {
      fontFamily: `${theme.fonts.sans.family}, sans-serif`,
      fontSize: "14px",
      primaryColor: c.accentSoft,
      primaryBorderColor: c.blue,
      primaryTextColor: c.ink,
      secondaryColor: "#ffffff",
      tertiaryColor: c.soft,
      lineColor: c.muted,
      textColor: c.ink,
      clusterBkg: c.soft,
      clusterBorder: "#c7d6e3",
      edgeLabelBackground: "#ffffff",
      noteBkgColor: c.openSoft,
      noteBorderColor: c.open,
      actorBkg: c.accentSoft,
      actorBorder: c.blue,
      actorTextColor: c.ink,
      signalColor: c.muted,
      signalTextColor: c.ink,
    },
  };
}

// Runs in the page before printing: waits for the fonts and draws the Mermaid diagrams as SVG.
const PAGE_SCRIPT = `
window.__prepare = async () => {
  await Promise.all([document.fonts.load('600 12px Geist'), document.fonts.load('400 12px "Geist Mono"'), document.fonts.ready]);
  const sources = [...document.querySelectorAll('.mermaid-src')];
  if (sources.length) {
    if (!window.mermaid) throw new Error('Mermaid wurde nicht geladen.');
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: false },
      sequence: { useMaxWidth: false }, ...window.__mermaidTheme });
    let n = 0;
    for (const source of sources) {
      n += 1;
      const out = source.parentElement.querySelector('.mermaid-out');
      const { svg } = await window.mermaid.render('mermaid-' + n, source.textContent);
      out.innerHTML = svg;
      const el = out.querySelector('svg');
      const box = el.viewBox && el.viewBox.baseVal;
      if (box && box.width) { el.setAttribute('width', box.width + 'px'); el.setAttribute('height', box.height + 'px'); }
      el.style.maxWidth = '100%'; el.style.height = 'auto';
    }
  }
  // Tables whose first column only holds short labels (numbers, ids) keep that column on one line.
  for (const table of document.querySelectorAll('.content table')) {
    const cells = [...table.querySelectorAll('tr')].map((row) => row.children[0]).filter(Boolean);
    if (cells.length && cells.every((cell) => cell.textContent.trim().length <= 14)) cells.forEach((cell) => cell.classList.add('nowrap'));
  }
  const images = [...document.images];
  await Promise.all(images.map((img) => img.decode().catch(() => {})));
  return sources.length;
};
`;
