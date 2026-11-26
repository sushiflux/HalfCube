// Draws a glyph of glyph-data.ts as inline SVG. Styles are set through React's style prop (the CSSOM), which the
// Content-Security-Policy allows; no markup string is ever injected.
import { createElement, type ReactNode, type SVGProps } from "react";
import { glyphData, type GlyphName, type GlyphNode } from "./glyph-data.ts";

export type { GlyphName } from "./glyph-data.ts";

function build(node: GlyphNode, key: number): ReactNode {
  const children = node.c?.map(build);
  return createElement(node.t, { key, ...node.a, ...(node.s ? { style: node.s } : {}) }, ...(children ?? []));
}

export type GlyphProps = Omit<SVGProps<SVGSVGElement>, "children"> & { name: GlyphName; size?: number | string };

/** A glyph in the 24 px grid, sized with `size` (default 1em) and coloured by currentColor. */
export function Glyph({ name, size = "1em", className, ...rest }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className ? `inline-block flex-none ${className}` : "inline-block flex-none"}
      {...rest}
    >
      {glyphData[name].map(build)}
    </svg>
  );
}
