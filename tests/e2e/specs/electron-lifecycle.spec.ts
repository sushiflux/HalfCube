// The Electron program as a whole: window title, a window that never takes the focus, one native engine process per
// window, and no engine process left when the program ends. Each test starts its own program with its own user data folder.
import { test as base, expect } from "@playwright/test";
import { engineChildren, launchElectron, processAlive, type LaunchedElectron } from "../support/electron-app.ts";
import { expectedVersionDisplay } from "../support/version.ts";

const test = base.extend<{ program: LaunchedElectron }>({
  // Playwright reads the fixture dependencies from the destructuring pattern; this fixture has none.
  // oxlint-disable-next-line no-empty-pattern
  program: async ({}, provide) => {
    const program = await launchElectron({ language: "en", colorMode: "light" });
    await provide(program);
    await program.close();
  },
});

test("the program starts inactive, shows its version in the title, runs one engine and leaves nothing behind", async ({ program }) => {
  const { app, page, pid } = program;

  // The engine is ready when the welcome screen follows the loading screen.
  await expect(page.getByRole("dialog", { name: "Sketch first, then build." })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("version")).toHaveText(`HalfCube ${expectedVersionDisplay()}`);

  const window = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no window");
    return { title: win.getTitle(), visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized(), count: BrowserWindow.getAllWindows().length };
  });
  expect(window.title).toBe(`HalfCube ${expectedVersionDisplay()}`);
  expect(window.count).toBe(1);
  expect(window.visible, "shown (inactive), so the page renders").toBe(true);
  expect(window.focused, "HALFCUBE_WINDOW=inactive: the window must not take the focus").toBe(false);

  // Exactly one native engine process, child of the program.
  const engines = engineChildren(pid);
  expect(engines, "one engine process belongs to the program").toHaveLength(1);
  const [engine] = engines;
  expect(engine).toBeDefined();
  expect(processAlive(engine ?? 0)).toBe(true);
  expect(program.errors, "no console errors").toEqual([]);

  // Closing the program ends the engine too (checked again by the fixture's close).
  await app.close();
  await expect.poll(() => processAlive(engine ?? 0), { message: "the engine process must end with the program", timeout: 10_000 }).toBe(false);
  expect(processAlive(pid)).toBe(false);
});

test("a second program with its own user data folder starts next to the first and keeps its own settings", async ({ program }) => {
  const first = program.page.getByRole("dialog", { name: "Sketch first, then build." });
  await expect(first).toBeVisible({ timeout: 60_000 });
  await first.getByText("Don’t show this at the next start").click();
  await expect(first.getByRole("checkbox")).toBeChecked();
  expect(await program.page.evaluate(() => localStorage.getItem("halfcube.welcome.hidden"))).toBe("1");

  const other = await launchElectron({ language: "de", colorMode: "dark" });
  try {
    // Its own first-start file: German, and nothing of the first program's stored preferences.
    await expect(other.page.getByRole("dialog", { name: "Sketch first, then build." })).toBeVisible({ timeout: 60_000 });
    expect(await other.page.evaluate(() => localStorage.getItem("halfcube.welcome.hidden"))).toBeNull();
    expect(other.userData).not.toBe(program.userData);
    expect(engineChildren(other.pid)).toHaveLength(1);
    expect(engineChildren(program.pid)).toHaveLength(1);
  } finally {
    await other.close();
  }
});
