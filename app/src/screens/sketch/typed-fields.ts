// The values a user types while a tool draws: length and angle of a line, width and height of a rectangle, the
// diameter of a circle. Pure state with live parsing: every keystroke re-reads the text, so the rubber band and the message
// follow the typing. Nothing here touches the sketch.
import { parseQuantity, type ParseOptions, type QuantityKind, type QuantityParse } from "../../document/index.ts";
import type { Quantity } from "../../document/types.ts";

export interface FieldDef<Id extends string = string> {
  id: Id;
  kind: QuantityKind;
  sign: NonNullable<ParseOptions["sign"]>;
}

/** Keys that start typing while a tool waits for its next point. */
export const startsTyping = (key: string): boolean => key.length === 1 && /[0-9.,+-]/.test(key);

export class TypedFields<Id extends string = string> {
  /** The field that has the keyboard; null while no typing is open. */
  active: Id | null = null;
  /**
   * The field the next typed character goes to. Before typing opens it is the first field and Tab moves it, so the user
   * can start with the second value (height, angle) without typing into the first.
   */
  selected: Id;
  private texts = new Map<Id, string>();

  readonly defs: readonly FieldDef<Id>[];

  constructor(defs: readonly FieldDef<Id>[]) {
    this.defs = defs;
    this.selected = defs[0]!.id;
  }

  get isOpen(): boolean {
    return this.active !== null;
  }

  /** Opens typing with the first typed character in the selected field (or the named one); it overwrites the live value. */
  open(first: string, field: Id = this.selected): void {
    this.texts.clear();
    this.texts.set(field, first);
    this.active = field;
    this.selected = field;
  }

  setText(id: Id, text: string): void {
    this.texts.set(id, text);
    this.active = id;
    this.selected = id;
  }

  focus(id: Id): void {
    if (this.active === null) return;
    this.active = id;
    this.selected = id;
  }

  /** Tab: the next field, round and round; before typing opens it only moves the selection. */
  next(): void {
    const i = this.defs.findIndex((d) => d.id === (this.active ?? this.selected));
    const id = this.defs[(i + 1) % this.defs.length]!.id;
    this.selected = id;
    if (this.active !== null) this.active = id;
  }

  close(): void {
    this.active = null;
    this.selected = this.defs[0]!.id;
    this.texts.clear();
  }

  text(id: Id): string {
    return this.texts.get(id) ?? "";
  }

  /** The user typed into this field: it keeps its value and no longer follows the pointer. */
  isLocked(id: Id): boolean {
    return this.text(id).trim() !== "";
  }

  /** null: nothing typed in this field (it stays calm, no message). */
  parse(id: Id): QuantityParse | null {
    const text = this.text(id);
    if (text.trim() === "") return null;
    const def = this.defs.find((d) => d.id === id)!;
    return parseQuantity(text, def.kind, { sign: def.sign });
  }

  /** The typed value, only when it reads correctly. */
  value(id: Id): Quantity | undefined {
    const p = this.parse(id);
    return p?.ok ? p.value : undefined;
  }

  /** Some field holds text that does not read as a value. */
  hasError(): boolean {
    return this.defs.some((d) => this.parse(d.id)?.ok === false);
  }

  /** Something valid was typed and nothing wrong. */
  get hasValues(): boolean {
    return this.isOpen && !this.hasError() && this.defs.some((d) => this.value(d.id) !== undefined);
  }
}
