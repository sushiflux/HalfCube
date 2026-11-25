// "Nothing moves" on the welcome screen at the narrowest supported width, in German and English: the dialog keeps its
// place and size when the page changes, when the checkbox is ticked and when the "not available" dialog opens on top;
// the page has no horizontal scrollbar and nothing sticks out.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";
import { expectNoHorizontalOverflow, expectNothingMoved, snapshot, type Targets } from "../support/layout.ts";
import { NARROWEST_WIDTH, type Lang } from "../support/paths.ts";

const words: Record<Lang, { title1: string; title2: string; next: string; back: string; open: RegExp; checkbox: string; infoTitle: string }> = {
  en: {
    title1: "Sketch first, then build",
    title2: "How do you want to start?",
    next: "Next",
    back: "Back",
    open: /Open a project or STEP file/,
    checkbox: "Don’t show this at the next start",
    infoTitle: "Not available yet",
  },
  de: {
    title1: "Erst skizzieren, dann bauen",
    title2: "Womit möchtest du anfangen?",
    next: "Weiter",
    back: "Zurück",
    open: /Projekt oder STEP-Datei öffnen/,
    checkbox: "Beim nächsten Start nicht mehr anzeigen",
    infoTitle: "Noch nicht verfügbar",
  },
};

function panelTargets(page: Page): Targets {
  const panel = page.getByRole("dialog").first();
  const footer = panel.locator("div.border-t").last();
  // The label itself stretches over the free room of the footer (it is invisible); what a user sees is the drawn box and its text.
  const checkbox: Locator = footer.locator("label");
  return {
    panel,
    footer,
    checkboxBox: checkbox.locator("span").first(),
    checkboxText: checkbox.locator("span").last(),
    closeButton: panel.getByRole("button", { name: /Close|Schließen/ }).first(),
    sidebarVersion: panel.locator("aside .mono"),
  };
}

for (const lang of ["en", "de"] as const) {
  test(`welcome screen: nothing moves (${lang === "de" ? "German" : "English"}, narrowest width)`, async ({ app }) => {
    const { page } = app;
    const w = words[lang];
    await app.open(`?demo=welcome&lang=${lang}`);
    const innerWidth = await app.setWidth(NARROWEST_WIDTH);
    test.info().annotations.push({ type: "width", description: `window ${NARROWEST_WIDTH} px, page ${innerWidth} px` });

    const dialog = page.getByRole("dialog", { name: w.title1 });
    await expect(dialog).toBeVisible();
    await expectNoHorizontalOverflow(page, "welcome page 1");
    const targets = panelTargets(page);
    const page1 = await snapshot(page, targets);

    // Tick the checkbox: nothing moves.
    await dialog.getByText(w.checkbox).click();
    await expect(dialog.getByRole("checkbox")).toBeChecked();
    expectNothingMoved(page1, await snapshot(page, targets), "checkbox ticked");

    // Page 2: the dialog itself keeps place and size, the footer and the checkbox stay where they are.
    await dialog.getByRole("button", { name: w.next }).click();
    const second = page.getByRole("dialog", { name: w.title2 });
    await expect(second).toBeVisible();
    await expectNoHorizontalOverflow(page, "welcome page 2");
    const page2 = await snapshot(page, targets);
    expectNothingMoved(page1, page2, "page 1 to page 2");

    // The info dialog opens on top: the welcome dialog stays exactly where it is.
    await second.getByRole("button", { name: w.open }).click();
    const info = page.getByRole("dialog", { name: w.infoTitle });
    await expect(info).toBeVisible();
    const withInfo = await snapshot(page, { ...targets, panel: second, footer: second.locator("div.border-t").last() });
    expectNothingMoved(page2, withInfo, "info dialog opens");
    // It is a dialog of ours, centred in the window and not wider than the window.
    const infoBox = await info.boundingBox();
    expect(infoBox, "the info dialog has a box").not.toBeNull();
    if (infoBox) {
      expect(infoBox.x).toBeGreaterThanOrEqual(0);
      expect(infoBox.x + infoBox.width).toBeLessThanOrEqual(innerWidth);
    }
    await expect(info).toContainText(lang === "de" ? "Projekte und STEP-Dateien" : "Projects and STEP files");
    await expectNotCut(info);
    await page.keyboard.press("Escape");
    await expect(info).toHaveCount(0);
    expectNothingMoved(page2, await snapshot(page, targets), "info dialog closes");
    expect(app.errors).toEqual([]);
  });
}

async function expectNotCut(dialog: Locator): Promise<void> {
  // The message text of the info dialog is shown completely: its scroll box needs no scrolling.
  const clipped = await dialog.evaluate((el) => {
    const out: string[] = [];
    for (const node of Array.from(el.querySelectorAll("*"))) {
      if (node.scrollHeight - node.clientHeight > 1 && ["auto", "scroll", "hidden"].includes(getComputedStyle(node).overflowY) && node.clientHeight > 0) {
        out.push(`${node.tagName.toLowerCase()} scrollHeight ${node.scrollHeight} > clientHeight ${node.clientHeight}`);
      }
    }
    return out;
  });
  expect(clipped, "text in the info dialog is cut off").toEqual([]);
}
