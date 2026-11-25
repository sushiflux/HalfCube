import { describe, expect, it } from "vitest";
import {
  buildCrashReport,
  parseComponentStack,
  parseStack,
  shortLocation,
  throwingFunction,
} from "../../../app/src/screens/crash/diagnostics.ts";

const chromium = `Error: boom
    at Broken (http://127.0.0.1:5313/src/App.tsx?t=1:12:9)
    at Object.react_stack_bottom_frame (http://127.0.0.1:5313/node_modules/.vite/deps/react-dom_client.js?v=abc:14139:12)
    at async load (http://127.0.0.1:5313/src/load.ts:3:5)
    at http://127.0.0.1:5313/src/anon.ts:1:1
    at <anonymous>`;

const firefox = `Broken@http://localhost:5313/src/App.tsx:12:9
@http://localhost:5313/src/main.tsx:4:1`;

describe("stack parser", () => {
  it("parses the Chromium format including async and anonymous frames", () => {
    const frames = parseStack(chromium);
    expect(frames).toHaveLength(5);
    expect(frames[0]).toMatchObject({ functionName: "Broken", line: 12, column: 9, isAsync: false });
    expect(frames[0]?.file).toBe("http://127.0.0.1:5313/src/App.tsx?t=1");
    expect(frames[1]?.functionName).toBe("Object.react_stack_bottom_frame");
    expect(frames[2]).toMatchObject({ functionName: "load", isAsync: true, line: 3 });
    expect(frames[3]).toMatchObject({ functionName: undefined, line: 1, column: 1 });
    expect(frames[4]).toMatchObject({ functionName: "<anonymous>", line: undefined });
  });

  it("parses the Firefox and Safari format", () => {
    const frames = parseStack(firefox);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ functionName: "Broken", line: 12, column: 9 });
    expect(frames[1]).toMatchObject({ functionName: undefined, line: 4 });
  });

  it("skips the message line and survives empty input", () => {
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack("")).toEqual([]);
    expect(parseStack("Error: nothing to parse")).toEqual([]);
  });

  it("names the function that threw and shortens the location for display", () => {
    const frames = parseStack(chromium);
    expect(throwingFunction(frames)).toBe("Broken");
    expect(shortLocation(frames[0] as (typeof frames)[number])).toBe("src/App.tsx:12:9");
    expect(throwingFunction([])).toBeUndefined();
  });
});

describe("component stack", () => {
  it("lists the component names, innermost first", () => {
    const stack = "\n    at Broken (http://x/App.tsx:1:1)\n    at Shell (http://x/App.tsx:5:1)\n    at ErrorBoundary (http://x/E.tsx:9:1)";
    expect(parseComponentStack(stack)).toEqual(["Broken", "Shell", "ErrorBoundary"]);
    expect(parseComponentStack(undefined)).toEqual([]);
  });
});

describe("crash report text", () => {
  it("contains message, version, environment, stack and component stack", () => {
    const text = buildCrashReport({
      name: "TypeError",
      message: "x is undefined",
      stack: "TypeError: x is undefined\n    at f (a.ts:1:2)",
      componentStack: "\n    at Foo",
      environment: {
        version: "v1.2.3.4.5 (</>)",
        channel: "dev",
        userAgent: "UA",
        url: "http://localhost/",
        viewport: "800 x 600",
        platform: "Win32",
        language: "de-DE, en",
        time: "2026-11-25 10:00:00",
      },
    });
    for (const part of ["TypeError: x is undefined", "v1.2.3.4.5 (</>)", "dev", "UA", "http://localhost/", "800 x 600", "at f (a.ts:1:2)", "at Foo", "2026-11-25 10:00:00"]) {
      expect(text).toContain(part);
    }
  });
});
