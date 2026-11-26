// Decides whether a key event belongs to the element that has the focus (typing, a dialog) or to the program's own shortcuts
// (Ctrl+Z, Ctrl+Y, the sketch tool letters, Esc, Delete). One rule for every global key handler.

const FIELD_SELECTOR = "input,textarea,select,[contenteditable='true']";
const DIALOG_SELECTOR = "[role='dialog'],[role='alertdialog']";

/** A checkbox or radio takes no text: the shortcuts keep working while one has the focus (it stays focused after a click). */
const isToggle = (el: Element): boolean => el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");

/**
 * True when the key event is meant for its target: a text field, a select, an editable element, or anything inside a dialog
 * (a checkbox in a dialog included: the dialog owns its keys). False for the work area, buttons and for a checkbox or radio
 * outside dialogs, so the program's shortcuts still work after one was ticked.
 */
export function keysBelongToTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(DIALOG_SELECTOR)) return true;
  const field = target.closest(FIELD_SELECTOR);
  return field !== null && !isToggle(field);
}
