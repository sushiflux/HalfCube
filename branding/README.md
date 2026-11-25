# Branding

This folder holds the product name and the logo files.

- `branding.json` is the only place where the product name is written down. The app, the desktop program, the window
  title and the build scripts read the name from there.
- `source/logo-square.png` is the original logo as a square PNG with transparency.
- `icons/` holds the logo scaled to the icon sizes (PNG 16 to 512 and a Windows `.ico`). They are produced by
  `npm run make:icons` (script `scripts/make-icons.mjs`). The script only scales the logo; it never redraws, crops or
  recolours it.

## Licence

The code of this repository is licensed under GPL-3.0-or-later (see `LICENSE` in the repository root). The product name
and the logo in this folder are **not** covered by the code licence. They are the property of the owner, and rules for
using them will follow.
