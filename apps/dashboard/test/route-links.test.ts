import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const DASHBOARD_ROOT = resolve(__dirname, "..");
const APP_ROOT = join(DASHBOARD_ROOT, "app");
const SCAN_ROOTS = [APP_ROOT, join(DASHBOARD_ROOT, "lib")];

interface RouteRef {
  file: string;
  line: number;
  raw: string;
  segments: string[];
}

describe("dashboard internal route links", () => {
  it("only links, redirects, and internal fetches to existing app routes", () => {
    const routes = discoverAppRoutes();
    const refs = SCAN_ROOTS.flatMap((root) => discoverRouteRefs(root));
    const deadRefs = refs.filter((ref) => !routes.some((route) => routeMatches(ref.segments, route)));

    expect(
      deadRefs.map((ref) => `${ref.file}:${ref.line} -> ${ref.raw}`),
      "Internal route references must match a Next app page or route handler.",
    ).toEqual([]);
  });
});

function discoverAppRoutes(): string[][] {
  return walk(APP_ROOT)
    .filter((file) => /\/(page|route)\.(tsx|ts)$/.test(file))
    .map((file) => {
      const rel = relative(APP_ROOT, file)
        .replace(/\/(page|route)\.(tsx|ts)$/, "")
        .replace(/^(page|route)\.(tsx|ts)$/, "");
      return rel
        .split("/")
        .filter(Boolean)
        .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));
    });
}

function discoverRouteRefs(root: string): RouteRef[] {
  return walk(root)
    .filter((file) => /\.(tsx|ts)$/.test(file))
    .flatMap((file) => refsInFile(file));
}

function refsInFile(file: string): RouteRef[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const refs: RouteRef[] = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const attrName = node.name.text;
      if (attrName === "href" || attrName === "to") {
        const raw = jsxAttributeString(node);
        if (raw) addRef(refs, file, node, raw);
      }
    }

    if (ts.isCallExpression(node) && node.arguments.length > 0 && isRouteCall(node.expression)) {
      const firstArg = node.arguments[0];
      const raw = firstArg ? expressionString(firstArg) : null;
      if (raw) addRef(refs, file, node, raw);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return refs;
}

function jsxAttributeString(node: ts.JsxAttribute): string | null {
  const initializer = node.initializer;
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return null;
  return expressionString(initializer.expression);
}

function expressionString(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (!ts.isTemplateExpression(expr)) return null;
  return `${expr.head.text}${expr.templateSpans.map((span) => `__DYN__${span.literal.text}`).join("")}`;
}

function isRouteCall(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "redirect" || expr.text === "fetch";
  return ts.isPropertyAccessExpression(expr) && (expr.name.text === "push" || expr.name.text === "replace");
}

function addRef(refs: RouteRef[], file: string, node: ts.Node, raw: string): void {
  const segments = normalizeRouteRef(raw);
  if (!segments) return;
  const pos = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
  refs.push({
    file: relative(DASHBOARD_ROOT, file),
    line: pos.line + 1,
    raw,
    segments,
  });
}

function normalizeRouteRef(raw: string): string[] | null {
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;

  let routePath = raw;
  const dynamicIndex = routePath.indexOf("__DYN__");
  if (dynamicIndex > 0 && routePath[dynamicIndex - 1] !== "/") {
    routePath = routePath.slice(0, dynamicIndex);
  }
  routePath = routePath.split(/[?#]/)[0] ?? routePath;
  if (!routePath) return [];

  return routePath.split("/").filter(Boolean);
}

function routeMatches(refSegments: string[], routeSegments: string[]): boolean {
  if (refSegments.length !== routeSegments.length) return false;
  return refSegments.every((segment, index) => {
    const routeSegment = routeSegments[index];
    return isDynamic(segment) || isDynamic(routeSegment) || segment === routeSegment;
  });
}

function isDynamic(segment: string | undefined): boolean {
  return segment === "__DYN__" || Boolean(segment?.startsWith("[") && segment.endsWith("]"));
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === ".next" || entry === "node_modules") continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}
