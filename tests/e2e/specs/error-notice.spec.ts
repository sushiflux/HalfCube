// ErrorNotice (component gallery): the headline with its code is never cut off, "Show details" unfolds the rest,
// "Copy" copies the complete text, also while folded. Nothing moves when the arrow is used or when "Copied" shows,
// in German and English at the narrowest supported window width.
import { expect, test } from "../support/fixtures.ts";
import { expectNotTruncated, expectNothingMoved, snapshot, type Targets } from "../support/layout.ts";
import { NARROWEST_WIDTH, type Lang } from "../support/paths.ts";
import { expectedVersionDisplay } from "../support/version.ts";

const words: Record<Lang, { show: string; hide: string; copy: string; copied: string }> = {
  en: { show: "Show details", hide: "Hide details", copy: "Copy", copied: "Copied" },
  de: { show: "Details anzeigen", hide: "Details ausblenden", copy: "Kopieren", copied: "Kopiert" },
};

// The gallery's example error is German in both languages (it is example content, not UI text).
const HEADLINE_START = "Gehäuse.pcraft konnte nicht geöffnet werden";
const CODE = "PC-FILE-003";
const DETAIL_TEXT = "In der Datei fehlt manifest.json.";
const DETAIL_CODE = "C:\\Users\\Name\\Documents\\Partcraft\\Gehäuse.pcraft";
const DETAIL_LAST = "Es wurde nichts verändert; geöffnete Projekte bleiben, wie sie waren.";

for (const lang of ["en", "de"] as const) {
  test(`error notice: unfold, copy, nothing moves (${lang === "de" ? "German" : "English"}, narrowest width)`, { tag: "@clipboard" }, async ({ app }) => {
    const { page } = app;
    const w = words[lang];
    await app.open(`?demo=gallery&lang=${lang}`);
    const innerWidth = await app.setWidth(NARROWEST_WIDTH);
    test.info().annotations.push({ type: "width", description: `window ${NARROWEST_WIDTH} px, page ${innerWidth} px` });

    const notice = page.locator(`[data-error-code="${CODE}"]`);
    await expect(notice).toBeVisible();
    const headline = notice.locator("div.min-w-0").first();
    // Stable handles: the arrow and the copy button change their label, not their identity.
    const toggle = notice.locator("button[aria-expanded]");
    const copy = notice.locator("button[data-copy-state]");
    const action = notice.getByRole("button", { name: "Open another file …" });

    // The complete headline and its code are visible from the start, folded.
    await expect(headline).toContainText(HEADLINE_START);
    await expect(headline).toContainText(`(${CODE})`);
    await expect(toggle).toHaveAccessibleName(w.show);
    await expect(copy).toHaveAccessibleName(w.copy);
    await expectNotTruncated(headline, "headline");
    await expect(page.getByText(DETAIL_TEXT)).toHaveCount(0);

    const targets: Targets = {
      card: notice,
      headline,
      toggle,
      copy,
      action,
      sectionHeading: page.getByRole("heading", { name: "Error notice" }),
      buttonsCard: page.locator("section").nth(0),
      formCard: page.locator("section").nth(2),
    };
    const folded = await snapshot(page, targets);

    // Unfold: the details appear below, everything above and beside stays exactly where it was.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAccessibleName(w.hide);
    await expect(notice.getByText(DETAIL_TEXT)).toBeVisible();
    await expect(notice.getByText(DETAIL_CODE)).toBeVisible();
    await expect(notice.getByText(DETAIL_LAST)).toBeVisible();
    const unfolded = await snapshot(page, targets);
    expectNothingMoved(folded, unfolded, "details unfold", { height: ["card"] });
    expect(unfolded.boxes.card?.height, "the card grows by the details").toBeGreaterThan(folded.boxes.card?.height ?? Infinity);
    await expectNotTruncated(headline, "headline, unfolded");

    // Copy while unfolded: the label changes to "Copied" in place.
    await copy.click();
    await expect(copy).toHaveAttribute("data-copy-state", "copied");
    await expect(copy).toHaveAccessibleName(w.copied);
    expectNothingMoved(unfolded, await snapshot(page, targets), "'Copied' shows");
    const unfoldedCopy = await app.readClipboard();
    // Back to "Copy" by itself, in place.
    await expect(copy).toHaveAttribute("data-copy-state", "idle");
    expectNothingMoved(unfolded, await snapshot(page, targets), "'Copied' goes away");

    // Fold again and copy again: the text is the same complete text, folded or not.
    await toggle.click();
    await expect(notice.getByText(DETAIL_TEXT)).toHaveCount(0);
    expectNothingMoved(folded, await snapshot(page, targets), "details fold again");
    await copy.click();
    await expect(copy).toHaveAttribute("data-copy-state", "copied");
    const foldedCopy = await app.readClipboard();
    expect(foldedCopy).toBe(unfoldedCopy);

    // The copied text is complete: message, code, every detail block, the version, where it ran, when.
    for (const part of [HEADLINE_START, "weil in der Datei die Datei manifest.json fehlt und der Inhalt sich nicht lesen lässt", CODE, DETAIL_TEXT, DETAIL_CODE, DETAIL_LAST, expectedVersionDisplay()]) {
      expect(foldedCopy, `the copied error text contains "${part}"`).toContain(part);
    }
    expect(foldedCopy).toContain(app.target === "electron" ? "Desktop" : "Browser");
    expect(app.errors).toEqual([]);
  });
}

test("error notice: the arrow and the copy button work by keyboard", async ({ app }) => {
  const { page } = app;
  await app.open("?demo=gallery&lang=en");
  const notice = page.locator('[data-error-code="PC-FILE-003"]');
  const toggle = notice.getByRole("button", { name: "Show details" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(notice.getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(notice.getByRole("button", { name: "Copy" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(notice.locator("button[data-copy-state]")).toHaveAttribute("data-copy-state", "copied");
});
