/**
 * Agentic Writing templates — markdown documents loaded from `templates/` and
 * used as the system prompt, replacing the default coding-agent persona.
 *
 * A template is just plain markdown; the whole file becomes the SP (no required
 * schema, no frontmatter parsing). `${name}` placeholders are substituted
 * (e.g. `${cwd}` from opts); unknown keys are left unchanged. Drop
 * `templates/blog.md` in your repo and start the TUI with `--template blog`.
 *
 * Resolution order for `--template <name>`:
 *  - If `name` contains a path separator or ends in `.md`, it is treated as an
 *    explicit path (relative to `cwd`), not a templates-dir lookup.
 *  - Otherwise: `templates/<name>.md`, then `templates/<name>/SP.md`.
 *  - The first existing, non-empty file wins; on miss a clear error lists the
 *    searched candidates.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const TEMPLATES_DIR = "templates";

export interface ResolveTemplateOptions {
  /** Base directory for relative paths and `${cwd}` substitution. Default: process.cwd(). */
  cwd?: string;
  /** Extra `${name}` substitutions merged after built-in vars (e.g. `cwd`). */
  vars?: Record<string, string>;
}

/** Substitute `${name}` placeholders. Unknown keys are left unchanged. */
export function renderTemplate(
  content: string,
  vars: Record<string, string> = {},
): string {
  return content.replace(/\$\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? vars[key]! : whole,
  );
}

function templateVars(opts: ResolveTemplateOptions): Record<string, string> {
  return { cwd: opts.cwd ?? process.cwd(), ...opts.vars };
}

/** True when `name` looks like a path rather than a bare template name. */
function isExplicitPath(name: string): boolean {
  return name.endsWith(".md") || name.includes(sep) || name.includes("/");
}

/**
 * Resolve a template name (or explicit path) to an absolute file path.
 * Returns the first existing candidate, or `null` if none match.
 */
export function resolveTemplatePath(
  name: string,
  opts: ResolveTemplateOptions = {},
): string | null {
  const base = opts.cwd ?? process.cwd();

  const candidates: string[] = [];
  if (isExplicitPath(name)) {
    candidates.push(resolve(base, name));
  } else {
    candidates.push(join(base, TEMPLATES_DIR, `${name}.md`));
    candidates.push(join(base, TEMPLATES_DIR, name, "SP.md"));
  }

  return candidates.find((p) => existsSync(p) && readFileSync(p, "utf-8").trim()) ?? null;
}

/**
 * Load a template's text. Throws a clear error listing the searched candidates
 * when nothing is found — mirrors the user-facing errors elsewhere in the harness.
 */
export function loadTemplate(name: string, opts: ResolveTemplateOptions = {}): string {
  const path = resolveTemplatePath(name, opts);
  if (path) {
    const raw = readFileSync(path, "utf-8").trim();
    return renderTemplate(raw, templateVars(opts));
  }

  const base = opts.cwd ?? process.cwd();
  const searched = isExplicitPath(name)
    ? [resolve(base, name)]
    : [
        join(base, TEMPLATES_DIR, `${name}.md`),
        join(base, TEMPLATES_DIR, name, "SP.md"),
      ];
  throw new Error(
    `Template not found: ${name}\nLooked in:\n${searched.map((p) => `  - ${p}`).join("\n")}`,
  );
}
