// Types of the message catalogues. German defines the shape; English is typed against it, so a key that exists in
// only one language does not compile.
import type { de } from "./de.ts";

export type Language = "de" | "en";
export const languages: readonly Language[] = ["de", "en"];

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
export type Messages = Widen<typeof de>;

type Paths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Paths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every dotted key of the catalogue, e.g. "common.copy". */
export type MessageKey = Paths<Messages>;

export type MessageParams = Readonly<Record<string, string | number>>;
