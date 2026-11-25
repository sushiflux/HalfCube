// Live validation of the form fields in the component gallery (?demo=gallery), in German and English at the narrowest
// supported window width: the message must be visible while typing (before any blur or click), and nothing may move when
// a message appears, changes or goes away (positions and sizes of labels, fields, message slots, buttons, cards, page width).
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";
import { expectNothingMoved, snapshot, type Targets } from "../support/layout.ts";
import { NARROWEST_WIDTH, type Lang } from "../support/paths.ts";

interface Texts {
  hint: string;
  required: string;
  tooShort3: string;
  tooLong21: string;
  mismatch: string;
}

const texts: Record<Lang, Texts> = {
  en: {
    hint: "At least 8 characters",
    required: "Required: please enter a value.",
    tooShort3: "Too short: 3 of at least 8 characters.",
    tooLong21: "Too long: 21 of at most 20 characters.",
    mismatch: "The entries do not match.",
  },
  de: {
    hint: "At least 8 characters", // the gallery's hint text is English in both languages
    required: "Pflichtfeld: bitte einen Wert eingeben.",
    tooShort3: "Zu kurz: 3 von mindestens 8 Zeichen.",
    tooLong21: "Zu lang: 21 von höchstens 20 Zeichen.",
    mismatch: "Die Eingaben stimmen nicht überein.",
  },
};

const labels: Record<Lang, { name: string; password: string; repeat: string }> = {
  en: { name: "Name", password: "Password", repeat: "Repeat password" },
  de: { name: "Name", password: "Password", repeat: "Repeat password" }, // gallery labels are English in both languages
};

/** The message slot under a field: the next sibling of the input. */
const slotOf = (input: Locator): Locator => input.locator("xpath=following-sibling::div[1]");

/** The message the user sees under a field (the invisible reserve texts have no id). */
const shownMessage = (input: Locator): Locator => slotOf(input).locator("[id]");

function section(page: Page, title: string): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: title }) });
}

for (const lang of ["en", "de"] as const) {
  test(`live validation and a steady layout, ${lang === "de" ? "German" : "English"}, at the narrowest width`, async ({ app }) => {
    const { page } = app;
    const t = texts[lang];
    await app.open(`?demo=gallery&lang=${lang}`);
    const innerWidth = await app.setWidth(NARROWEST_WIDTH);
    expect(innerWidth, "the window really is at the narrowest supported width").toBeLessThanOrEqual(NARROWEST_WIDTH);
    test.info().annotations.push({ type: "width", description: `window ${NARROWEST_WIDTH} px, page ${innerWidth} px` });

    const form = section(page, "Fields with live validation");
    const name = form.getByLabel(labels[lang].name, { exact: true });
    const password = form.getByLabel(labels[lang].password, { exact: true });
    const repeat = form.getByLabel(labels[lang].repeat, { exact: true });
    const submit = form.getByRole("button", { name: "Submit" });
    const sections = page.locator("section");

    const targets: Targets = {
      heading: form.getByRole("heading"),
      card: form,
      nameLabel: form.locator("label", { hasText: labels[lang].name }).first(),
      nameInput: name,
      nameSlot: slotOf(name),
      passwordInput: password,
      passwordSlot: slotOf(password),
      repeatInput: repeat,
      repeatSlot: slotOf(repeat),
      submit,
      buttonsCard: sections.nth(0),
      toggleCard: sections.nth(1),
      dialogsCard: sections.nth(3),
      errorCard: sections.nth(4),
    };

    // Untouched: calm, the hint shows.
    await expect(shownMessage(name)).toHaveText(t.hint);
    await expect(name).toHaveAttribute("aria-invalid", "false");
    const calm = await snapshot(page, targets);

    // Typing three characters: the message is there while the field still has the focus, no blur, no click.
    await name.click();
    await name.pressSequentially("abc");
    await expect(name).toBeFocused();
    await expect(form.getByRole("alert").filter({ hasText: t.tooShort3 })).toBeVisible();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    expectNothingMoved(calm, await snapshot(page, targets), "too short appears");

    // Long enough: the message goes, the hint is back.
    await name.pressSequentially("defgh");
    await expect(form.getByRole("alert")).toHaveCount(0);
    await expect(shownMessage(name)).toHaveText(t.hint);
    await expect(name).toHaveAttribute("aria-invalid", "false");
    expectNothingMoved(calm, await snapshot(page, targets), "message goes away");

    // Too long: 8 + 13 = 21 characters.
    await name.pressSequentially("ijklmnopqrstu");
    await expect(form.getByRole("alert").filter({ hasText: t.tooLong21 })).toBeVisible();
    expectNothingMoved(calm, await snapshot(page, targets), "too long appears");

    // Emptied again after typing: required.
    await name.fill("");
    await expect(form.getByRole("alert").filter({ hasText: t.required })).toBeVisible();
    expectNothingMoved(calm, await snapshot(page, targets), "required appears");

    // Repeat field: a correct beginning stays calm, the first wrong character is flagged at once.
    await password.click();
    await password.pressSequentially("secret12");
    await repeat.click();
    await repeat.pressSequentially("sec");
    await expect(repeat).toHaveAttribute("aria-invalid", "false");
    await repeat.pressSequentially("x");
    await expect(form.getByRole("alert").filter({ hasText: t.mismatch })).toBeVisible();
    await expect(repeat).toHaveAttribute("aria-invalid", "true");
    expectNothingMoved(calm, await snapshot(page, targets), "mismatch appears");

    // Only now press the button: untouched fields are flagged too, and still nothing moves.
    await submit.click();
    await expect(form.getByRole("alert").filter({ hasText: t.required })).toBeVisible();
    expectNothingMoved(calm, await snapshot(page, targets), "after the submit attempt");

    expect(app.errors).toEqual([]);
  });
}

test("a message is shown with text and icon, not by colour alone", async ({ app }) => {
  const { page } = app;
  await app.open("?demo=gallery&lang=en");
  const form = section(page, "Fields with live validation");
  const name = form.getByLabel("Name", { exact: true });
  await name.pressSequentially("ab");
  const alert = form.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert.locator("svg")).toHaveCount(1);
  await expect(alert).toHaveText("Too short: 2 of at least 8 characters.");
  // The text names the problem and the current state: complete, never cut.
  const box = await alert.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
});
