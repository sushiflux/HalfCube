// Product name and identifiers. The single source is branding/branding.json; everything else reads it from here.
import brandingFile from "../../branding/branding.json" with { type: "json" };

export interface Branding {
  /** Display name of the product. */
  name: string;
  /** Lowercase identifier for file names and internal hosts (letters, digits, hyphens). */
  slug: string;
  /** Tagline under the wordmark. English in every UI language, so it is not part of the translations. */
  slogan: string;
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validates the content of branding.json. */
export function parseBranding(raw: unknown): Branding {
  if (typeof raw !== "object" || raw === null) throw new Error("branding.json must contain an object.");
  const { name, slug, slogan } = raw as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error('branding.json: "name" must be a non-empty string.');
  }
  if (typeof slug !== "string" || !slugPattern.test(slug)) {
    throw new Error('branding.json: "slug" must be lowercase letters, digits and hyphens, e.g. "my-product".');
  }
  if (typeof slogan !== "string" || slogan.trim() === "") {
    throw new Error('branding.json: "slogan" must be a non-empty string.');
  }
  return { name: name.trim(), slug, slogan: slogan.trim() };
}

export const branding: Branding = parseBranding(brandingFile);
