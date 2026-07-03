import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadTemplate, renderTemplate } from "../../src/templates.js";

describe("renderTemplate", () => {
  it("substitutes known keys and leaves unknown placeholders", () => {
    expect(
      renderTemplate("dir: ${cwd}, args: ${arguments}", { cwd: "/proj" }),
    ).toBe("dir: /proj, args: ${arguments}");
  });
});

describe("loadTemplate", () => {
  it("interpolates ${cwd} from opts", () => {
    const root = join(tmpdir(), `ds-forge-template-${Date.now()}`);
    mkdirSync(join(root, "templates"), { recursive: true });
    writeFileSync(
      join(root, "templates", "test.md"),
      "Working directory: ${cwd}\n",
    );

    expect(loadTemplate("test", { cwd: root })).toBe(
      `Working directory: ${root}`,
    );
  });
});
