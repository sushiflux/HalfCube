// Regenerates app/src/theme/themes.generated.css from the theme data: `npm run make:theme-css`.
import { writeFileSync } from "node:fs";
import { buildThemeCss } from "../../../app/src/theme/css.ts";

const target = new URL("../../../app/src/theme/themes.generated.css", import.meta.url);
writeFileSync(target, buildThemeCss());
console.log(`Wrote ${target.pathname}`);
