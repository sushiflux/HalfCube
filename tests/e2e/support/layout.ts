// "Nothing moves" helpers: position and size of named elements, page width, and the comparison of two snapshots.
import { expect, type Locator, type Page } from "@playwright/test";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutSnapshot {
  /** Position and size of every named element (content coordinates: scrolling does not change them). */
  boxes: Record<string, Box>;
  /** Width of the whole page content: a message must never widen the page or add a horizontal scrollbar. */
  scrollWidth: number;
  clientWidth: number;
}

export type Targets = Record<string, Locator>;

async function readOnce(page: Page, targets: Targets): Promise<LayoutSnapshot> {
  const boxes: Record<string, Box> = {};
  for (const [name, locator] of Object.entries(targets)) {
    const box = await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      // Content coordinates: add what every scrolled ancestor (the window, the gallery's own scroll area) has scrolled,
      // so scrolling an element into view is not mistaken for the layout moving.
      let x = r.x + window.scrollX;
      let y = r.y + window.scrollY;
      for (let p = el.parentElement; p; p = p.parentElement) {
        x += p.scrollLeft;
        y += p.scrollTop;
      }
      return { x, y, width: r.width, height: r.height };
    });
    boxes[name] = box;
  }
  const widths = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  return { boxes, ...widths };
}

/** Waits for fonts and running animations to finish, then reads the layout once it is the same two reads in a row. */
export async function snapshot(page: Page, targets: Targets): Promise<LayoutSnapshot> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
  let previous = await readOnce(page, targets);
  let stable = previous;
  await expect
    .poll(
      async () => {
        const next = await readOnce(page, targets);
        const same = JSON.stringify(next) === JSON.stringify(previous);
        previous = next;
        if (same) stable = next;
        return same;
      },
      { message: "the layout never settled (elements kept moving by themselves)", intervals: [50, 100, 100, 250], timeout: 8000 },
    )
    .toBe(true);
  return stable;
}

/** Describes every difference between two snapshots, for the assertion message. Exact comparison: not a pixel moves. */
export function differences(before: LayoutSnapshot, after: LayoutSnapshot, ignore: { height?: readonly string[]; all?: readonly string[] } = {}): string[] {
  const out: string[] = [];
  for (const name of Object.keys(before.boxes)) {
    if (ignore.all?.includes(name)) continue;
    const a = before.boxes[name];
    const b = after.boxes[name];
    if (!a || !b) {
      out.push(`${name}: missing`);
      continue;
    }
    for (const key of ["x", "y", "width", "height"] as const) {
      if (key === "height" && ignore.height?.includes(name)) continue;
      if (a[key] !== b[key]) out.push(`${name}.${key}: ${a[key]} -> ${b[key]}`);
    }
  }
  if (before.scrollWidth !== after.scrollWidth) out.push(`page scrollWidth: ${before.scrollWidth} -> ${after.scrollWidth}`);
  if (before.clientWidth !== after.clientWidth) out.push(`page clientWidth: ${before.clientWidth} -> ${after.clientWidth}`);
  return out;
}

/** Asserts that nothing named in `before` moved or changed its size (except what `ignore` allows). */
export function expectNothingMoved(before: LayoutSnapshot, after: LayoutSnapshot, what: string, ignore: { height?: readonly string[]; all?: readonly string[] } = {}): void {
  expect(differences(before, after, ignore), `${what}: elements moved or changed size`).toEqual([]);
}

/** The page has no horizontal scrollbar and no element sticks out to the right. */
export async function expectNoHorizontalOverflow(page: Page, what: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > width + 0.5 && getComputedStyle(el).position !== "fixed") {
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)} > ${width}`);
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, width, out: out.slice(0, 5) };
  });
  expect(overflow.scrollWidth, `${what}: horizontal scrollbar (scrollWidth ${overflow.scrollWidth} > ${overflow.width})`).toBeLessThanOrEqual(overflow.width);
  expect(overflow.out, `${what}: elements stick out to the right`).toEqual([]);
}

/** A text that is shown completely: not cut by overflow, ellipsis or a line clamp. */
export async function expectNotTruncated(locator: Locator, what: string): Promise<void> {
  const info = await locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      clipX: el.scrollWidth - el.clientWidth,
      clipY: el.scrollHeight - el.clientHeight,
      ellipsis: cs.textOverflow === "ellipsis",
      clamp: cs.getPropertyValue("-webkit-line-clamp") !== "none" && cs.getPropertyValue("-webkit-line-clamp") !== "",
    };
  });
  expect(info.ellipsis, `${what}: text-overflow ellipsis`).toBe(false);
  expect(info.clamp, `${what}: line clamp`).toBe(false);
  expect(info.clipX, `${what}: cut off horizontally`).toBeLessThanOrEqual(1);
  expect(info.clipY, `${what}: cut off vertically`).toBeLessThanOrEqual(1);
}
