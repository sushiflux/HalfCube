// Types of the licence list of "About Partcraft", built from the generated third-party data (app/src/about/third-party.generated.ts).
import type { Language } from "../i18n/types.ts";

export type LocalizedText = Readonly<Record<Language, string>>;

/** One bundled component as the generator writes it (the entry type is defined next to the data it describes). */
export type { ThirdPartyEntry } from "./third-party.generated.ts";

export type ThirdPartyGroup = "engine" | "ui" | "shell";

export type LicenceGroup = "self" | ThirdPartyGroup;

export const licenceGroups: readonly LicenceGroup[] = ["self", "engine", "ui", "shell"];

/** What the licence list shows for one component, whether it comes from the generated data or is one of the project's own texts. */
export interface LicenceItem {
  id: string;
  group: LicenceGroup;
  name: string;
  version: string | LocalizedText;
  /** SPDX expression (or a short statement for the NOTICE file). */
  license: string | LocalizedText;
  /** A friendlier name of the licence, shown in the list and above the SPDX expression in the detail. */
  licenseLabel?: string | LocalizedText;
  copyright: readonly string[];
  source: string;
  purpose: LocalizedText;
  textFile: string | null;
  note?: LocalizedText | string;
}
