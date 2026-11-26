// The tool list of the sketch toolbar and the factory that builds a tool.
import { ConstraintTool, type ConstraintToolId } from "./constraint-tool.ts";
import { DimensionTool } from "./dimension-tool.ts";
import { CircleTool, LineTool, RectangleTool } from "./draw-tools.ts";
import { SelectTool } from "./select-tool.ts";
import type { Tool, ToolContext, ToolId } from "./tool.ts";

export const constraintToolIds: readonly ConstraintToolId[] = ["coincident", "horizontal", "vertical", "fix", "parallel", "perpendicular", "equal", "pointOnCurve"];

export function isConstraintTool(id: ToolId): id is ConstraintToolId {
  return (constraintToolIds as readonly string[]).includes(id);
}

export function createTool(id: ToolId, ctx: ToolContext): Tool {
  if (id === "select") return new SelectTool(ctx);
  if (id === "line") return new LineTool(ctx);
  if (id === "rectangle") return new RectangleTool(ctx);
  if (id === "circle") return new CircleTool(ctx);
  if (id === "dimension") return new DimensionTool(ctx);
  return new ConstraintTool(ctx, id);
}

/** Single keys that start a tool while a sketch is open (the same letters as in other CAD programs). */
export const toolKeys: Partial<Record<ToolId, string>> = { line: "L", rectangle: "R", circle: "C", dimension: "D" };
