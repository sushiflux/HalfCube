// A new, empty document: the root component without bodies and an empty timeline.
import { DOCUMENT_FORMAT, type PartcraftDocument } from "./types.ts";

export interface NewDocumentOptions {
  /** Name of the root component as the user sees it (translated by the caller). */
  rootName: string;
  /** Default: a random UUID. */
  documentId?: string;
}

export function createEmptyDocument(options: NewDocumentOptions): PartcraftDocument {
  return {
    format: DOCUMENT_FORMAT,
    documentId: options.documentId ?? crypto.randomUUID(),
    settings: { lengthUnit: "mm" },
    nextId: 1,
    parameters: [],
    components: [{ id: "root", name: options.rootName, bodies: [] }],
    timeline: [],
  };
}
