import type { z } from "zod";

type ToolResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

export type ToolDef<T extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  inputSchema: T;
  handler: (args: z.infer<T>) => Promise<ToolResult> | ToolResult;
};
