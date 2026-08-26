"use client";

import { useMemo, useState } from "react";
import { Download, FileCode2, FileJson, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  toJsonSchema,
  toMarkdown,
  toTypeScript,
} from "../../../../lib/data-contracts/export";
import type { InferredDataContract } from "../../../../lib/data-contracts/inference";

type Format = "markdown" | "typescript" | "json-schema";

const FORMAT_META: Record<
  Format,
  { label: string; icon: React.ComponentType<{ className?: string }>; extension: string; mime: string }
> = {
  markdown: { label: "Markdown", icon: FileText, extension: "md", mime: "text/markdown" },
  typescript: { label: "TypeScript", icon: FileCode2, extension: "ts", mime: "text/typescript" },
  "json-schema": { label: "JSON Schema", icon: FileJson, extension: "json", mime: "application/json" },
};

/**
 * Schema export panel — generates and downloads operator-facing
 * artifacts from the saved Data Contract version. Pure client-side: the
 * schema is already serialized on the page, so we don't round-trip
 * through the server for export. Downloads as a Blob so the customer
 * can drop it straight into their codebase.
 */
export function SchemaExportPanel({
  schema,
  dataContractName,
}: {
  schema: InferredDataContract;
  dataContractName: string;
}) {
  const [active, setActive] = useState<Format>("markdown");

  const contents = useMemo(() => {
    const context = { name: dataContractName };
    if (active === "markdown") return toMarkdown(schema, context);
    if (active === "typescript") return toTypeScript(schema, context);
    return JSON.stringify(toJsonSchema(schema, context), null, 2);
  }, [active, schema, dataContractName]);

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Download className="size-3.5" /> Export schema
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Drop the Data Contract's contract straight into your codebase. Markdown
        for docs; TypeScript for type-safe consumers; JSON Schema for API
        tooling. Sensitive fields stay flagged in every format.
      </p>

      <div className="mb-3 flex flex-wrap gap-2">
        {(Object.keys(FORMAT_META) as Format[]).map((fmt) => {
          const meta = FORMAT_META[fmt];
          const Icon = meta.icon;
          return (
            <button
              key={fmt}
              type="button"
              onClick={() => setActive(fmt)}
              className={
                "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition-colors " +
                (active === fmt
                  ? "border-foreground/30 bg-foreground text-background"
                  : "border-border bg-background text-foreground hover:bg-muted")
              }
            >
              <Icon className="size-3" />
              {meta.label}
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {dataContractName}.{FORMAT_META[active].extension}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              const blob = new Blob([contents], { type: FORMAT_META[active].mime });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${dataContractName.replace(/[^A-Za-z0-9]+/g, "-")}.${FORMAT_META[active].extension}`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            }}
          >
            <Download className="mr-1 size-3" />
            Download
          </Button>
        </div>
        <pre className="max-h-96 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-foreground">
          {contents}
        </pre>
      </div>
    </section>
  );
}
