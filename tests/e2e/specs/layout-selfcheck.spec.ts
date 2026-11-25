// The "nothing moves" check itself must notice what it is there for: a moved element, a resized element and a page
// that gets wider. Without this, a check that never fails would look like a passing product.
import { expect, test } from "../support/fixtures.ts";
import { differences, snapshot } from "../support/layout.ts";

test("the layout check notices a moved element, a resized element and a wider page", async ({ app }) => {
  const { page } = app;
  await app.open("?demo=gallery&lang=en");
  const targets = { heading: page.getByRole("heading", { name: "Buttons" }), card: page.locator("section").first() };
  const before = await snapshot(page, targets);
  expect(differences(before, await snapshot(page, targets))).toEqual([]);

  await page.evaluate(() => {
    const h = document.querySelector("h2");
    if (h) h.style.marginTop = "3px";
  });
  expect(differences(before, await snapshot(page, targets)).join("\n")).toContain("heading.y");

  await page.evaluate(() => {
    const card = document.querySelector("section");
    if (card) card.style.width = "300px";
  });
  expect(differences(before, await snapshot(page, targets)).join("\n")).toContain("card.width");

  await page.evaluate(() => {
    const wide = document.createElement("div");
    wide.style.cssText = "width: 4000px; height: 1px;";
    document.body.appendChild(wide);
  });
  expect(differences(before, await snapshot(page, targets)).join("\n")).toContain("page scrollWidth");
});
