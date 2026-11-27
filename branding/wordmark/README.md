# HalfCube wordmark (SVG)

The wordmark "HalfCube" as vector outlines: the letters are paths, so the files need no font and look the same
everywhere. "Half" and "Cube" are two separate paths so the two colours stay exact.

| File | Background | Setting |
|---|---|---|
| `halfcube-wordmark-light.svg` | light | large: weight 600, letter spacing -0.028 em |
| `halfcube-wordmark-dark.svg` | dark | large: weight 600, letter spacing -0.028 em |
| `halfcube-wordmark-light-small.svg` | light | small: weight 640, letter spacing +0.004 em |
| `halfcube-wordmark-dark-small.svg` | dark | small: weight 640, letter spacing +0.004 em |

## Which file to use

- Use the **large** files from a text size of about 28 px upwards, the **small** files below that. The small setting is
  the same wordmark with a slightly heavier weight and looser spacing so it stays legible at title-bar size; it is the
  only difference between the two.
- Pick **light** or **dark** by the background the wordmark sits on, not by the colour theme of the program.
- Scale the files only; never recolour, stretch or redraw them. The wordmark is also used together with the logo
  (logo plus wordmark) or without it; the logo is a separate file and is never changed.

## Colours (fixed, independent of the colour theme)

| Background | "Half" | "Cube" |
|---|---|---|
| light | #16476E | #1F75AE |
| dark | #FFFFFF | #4CD1E0 |

## Geometry

- Coordinates are font units (1 em = 1000 units), the y axis points down, the view box is the tight outline of the
  letters (no padding). The intrinsic size of each file is that of a 100 px font size; give the image the height you need.
- Kerning of the font is applied; the letter spacing is added after every letter.

## Font and licence

The outlines come from **Geist** (Vercel in collaboration with basement.studio), SIL Open Font License 1.1; the licence
text is in `app/src/assets/fonts/OFL-LICENSE.txt`. The licence permits using the font for artwork and documents; the
font file itself is not part of these SVG files. The font declares no reserved font name.

## Where the outlines are used

One source, four users; every copy is generated from the same outlines, nothing is typeset from a font:

| Where | How |
|---|---|
| Program | `app/src/ui/wordmark.generated.ts`, drawn by the `Wordmark` component (inline SVG paths, small setting below 28 px) |
| Manuals (PDF cover) | these SVG files, inlined by `scripts/docs-pdf/render.mjs` |
| Setup (.NET) | `installer/setup/Ui/WordmarkOutline.generated.cs`, drawn as a `GraphicsPath` by `Branding.DrawWordmark` |
| README | these SVG files, light or dark by `prefers-color-scheme` |

## Rebuilding

`scripts/make-wordmark.mjs` rebuilds the four SVG files, the TypeScript module of the program and the C# file of the setup
from `app/src/assets/fonts/Geist-Variable.woff2`. It needs fontkit (MIT), which is deliberately not a project dependency:
run `npm install --no-save fontkit` first, then `node scripts/make-wordmark.mjs`. The variable font is set to the exact
weight before the outlines are read; nothing is drawn by hand. The product name and slug come from
`branding/branding.json`. Commit the generated files together; a unit test checks that they agree.
