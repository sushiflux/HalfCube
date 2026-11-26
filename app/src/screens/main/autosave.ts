// The working document survives a reload: it is kept in the tab's session storage (gone when the tab or window is closed)
// and read back at the next start of the page. It is a stop-gap until real files exist; nothing here is a save.
import { absoluteLabelsToRelative, documentProblems, numberNamesInDocument, serializeDocument } from "../../document/index.ts";
import type { PartcraftDocument } from "../../document/types.ts";

// The key names the working format: ".2" stores dimension labels relative to the measured geometry. A document under the
// older key (absolute label points) is converted once at the next start and moves to the new key.
export const sessionDocumentKey = "partcraft.session.document.2";
export const legacySessionDocumentKey = "partcraft.session.document";

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): SessionStorageLike | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function removeQuietly(store: SessionStorageLike, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // Nothing to clean up.
  }
}

/** The document stored under `key`, or undefined when there is none or it does not pass the document check (then it is dropped). */
function readValid(store: SessionStorageLike, key: string): PartcraftDocument | undefined {
  try {
    const text = store.getItem(key);
    if (text === null) return undefined;
    const doc = JSON.parse(text) as PartcraftDocument;
    if (documentProblems(doc).length === 0) return doc;
  } catch {
    // Damaged text: dropped below.
  }
  removeQuietly(store, key);
  return undefined;
}

/**
 * The stored document, or undefined when there is none or it does not pass the document check (then it is dropped).
 * A document of the older working format is converted and kept under the current key; one that cannot be converted is dropped.
 */
export function loadSessionDocument(store: SessionStorageLike | undefined = storage()): PartcraftDocument | undefined {
  if (!store) return undefined;
  // A stored document from before the names of shapes gets its numbers (in creation order); one that has them is left alone.
  const current = readValid(store, sessionDocumentKey);
  if (current) return numberNamesInDocument(current);
  const legacy = readValid(store, legacySessionDocumentKey);
  if (!legacy) return undefined;
  removeQuietly(store, legacySessionDocumentKey);
  try {
    const converted = numberNamesInDocument(absoluteLabelsToRelative(legacy));
    if (documentProblems(converted).length > 0) return undefined;
    saveSessionDocument(converted, store);
    return converted;
  } catch {
    return undefined;
  }
}

export function saveSessionDocument(doc: PartcraftDocument, store: SessionStorageLike | undefined = storage()): void {
  try {
    store?.setItem(sessionDocumentKey, serializeDocument(doc));
  } catch {
    // Storage refused (full, locked down): the document just does not survive a reload.
  }
}
