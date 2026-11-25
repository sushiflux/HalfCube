// Product name and identifiers. The single source is branding/branding.json; everything else reads it from here.
import brandingFile from "../../branding/branding.json";

export interface Branding {
  /** Display name of the product. */
  name: string;
  /** Lowercase identifier for file names and internal hosts (letters, digits, hyphens). */
  slug: string;
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validates the content of branding.json. */
export function parseBranding(raw: unknown): Branding {
  if (typeof raw !== "object" || raw === null) throw new Error("branding.json must contain an object.");
  const { name, slug } = raw as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error('branding.json: "name" must be a non-empty string.');
  }
  if (typeof slug !== "string" || !slugPattern.test(slug)) {
    throw new Error('branding.json: "slug" must be lowercase letters, digits and hyphens, e.g. "my-product".');
  }
  return { name: name.trim(), slug };
}

export const branding: Branding = parseBranding(brandingFile);
