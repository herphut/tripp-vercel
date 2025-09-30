// app/api/_lib/toolvalidator.ts
import "server-only";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";


// Minimal tool shape (keeps it decoupled from your tools file)
type ToolDef = {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
};

export type ToolRegistry = {
  byName: Map<
    string,
    {
      schema: Record<string, unknown> | undefined;
      validate: ValidateFunction | null;
      description?: string;
    }
  >;
};

export function validateToolDefinitions(tools: ToolDef[]): ToolRegistry {
  const ajv = new Ajv({ allErrors: true, strict: true, removeAdditional: false });
  const byName = new Map<string, { schema: any; validate: ValidateFunction | null; description?: string }>();

  for (const t of tools || []) {
    if (!t || typeof t.name !== "string" || t.name.trim() === "") continue;
    let validate: ValidateFunction | null = null;
    if (t.input_schema && typeof t.input_schema === "object") {
      try {
        validate = ajv.compile(t.input_schema as any);
      } catch (e) {
        // If a schema is bad, we still register the tool but with no validator.
        validate = null;
      }
    }
    byName.set(t.name, {
      schema: (t.input_schema as any) || undefined,
      validate,
      description: t.description,
    });
  }

  return { byName };
}

// Validate a specific invocation (args) against the tool's schema
export function validateInvocation(reg: ToolRegistry, name: string, args: unknown): { ok: true } | { ok: false; errors: string[] } {
  const item = reg.byName.get(name);
  if (!item) return { ok: false, errors: [`unknown_tool:${name}`] };
  if (!item.validate) return { ok: true }; // no schema means we accept anything

  const ok = item.validate(args);
  if (ok) return { ok: true };

  const errors = (item.validate.errors || []).map((e) => {
    const path = e.instancePath || e.schemaPath || "";
    const msg = e.message || "invalid";
    return `${path} ${msg}`.trim();
  });
  return { ok: false, errors: errors.length ? errors : ["invalid_arguments"] };
}

// Convert your internal tools to Responses API "tools" payload
export function toolsToFunctions(tools: ToolDef[]): Array<{
  type: "function";
  name: string;
  description?: string;
  parameters: any;
  strict?: boolean;
}> {
  return (tools || [])
    .filter((t) => t && typeof t.name === "string" && t.name.trim())
    .map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description || "",
      parameters: (t.input_schema as any) ?? { type: "object", properties: {} },
      strict: true,
    }));
}
