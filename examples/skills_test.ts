#!/usr/bin/env npx tsx
/**
 * Skill system test suite. No API calls — uses Node assert and a temp directory
 * of fixture SKILL.md files.
 *
 * Run: npm run test (via root test suite)
 *   SKILLS_TEST_VERBOSE=1 npx tsx examples/skills_test.ts
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  Forge,
  SkillRegistry,
  discoverSkills,
  loadSkillsFromDir,
  parseFrontmatter,
  parseSkill,
  renderSkill,
  skillTool,
  skillsCatalog,
  toSkillRegistry,
} from "../src/index.js";

const VERBOSE = !!process.env.SKILLS_TEST_VERBOSE;
let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    if (VERBOSE) console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`\n  ✗ FAIL [${name}]`);
    console.error(`    ${(e as Error).message}`);
  }
}

/** Build a temp skills tree and return its root dir. */
function fixtureDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ds-forge-skills-"));
  const skills = join(root, ".agents", "skills");

  const review = join(skills, "review");
  mkdirSync(review, { recursive: true });
  writeFileSync(
    join(review, "SKILL.md"),
    `---
name: review
description: Review code changes for security, performance, and style.
allowed-tools: [read, grep, bash]
model: deepseek-v4-pro
---
Review the files in \${arguments} with focus on correctness.
Skill dir: \${SKILL_DIR}`,
  );

  // Block-array frontmatter + name defaulting to dir name.
  const test = join(skills, "run-tests");
  mkdirSync(test, { recursive: true });
  writeFileSync(
    join(test, "SKILL.md"),
    `---
description: Run the test suite and report failures.
allowed-tools:
  - bash
---
Run npm test and summarize results.`,
  );

  // Legacy single-file form.
  writeFileSync(
    join(skills, "greet.md"),
    `---
name: greet
description: Say hello.
---
Greet the user warmly.`,
  );

  return root;
}

async function main() {
  console.log("Skill Test Suite\n");

  await check("parseFrontmatter: scalars, inline + block arrays", () => {
    const inline = parseFrontmatter(
      `---\nname: a\ntags: [x, y, z]\n---\nbody here`,
    );
    assert.strictEqual(inline.data.name, "a");
    assert.deepStrictEqual(inline.data.tags, ["x", "y", "z"]);
    assert.strictEqual(inline.body, "body here");

    const block = parseFrontmatter(`---\nlist:\n  - one\n  - two\n---\nB`);
    assert.deepStrictEqual(block.data.list, ["one", "two"]);

    const none = parseFrontmatter("just a body, no frontmatter");
    assert.deepStrictEqual(none.data, {});
    assert.strictEqual(none.body, "just a body, no frontmatter");
  });

  await check("parseFrontmatter: strips quotes", () => {
    const { data } = parseFrontmatter(`---\nname: "Quoted Name"\n---\nx`);
    assert.strictEqual(data.name, "Quoted Name");
  });

  await check("parseFrontmatter: folded scalars + nested YAML", () => {
    const { data } = parseFrontmatter(`---
name: agent-reach
description: >
  Give your AI agent eyes to see the entire internet.
  17 platforms via CLI, MCP, curl, and Python scripts.

  Use when the user asks to search the web.
triggers:
  - social:
    - Twitter: twitter/x.com
metadata:
  openclaw:
    homepage: https://example.com
---
body`);
    assert.strictEqual(
      data.description,
      "Give your AI agent eyes to see the entire internet. 17 platforms via CLI, MCP, curl, and Python scripts.\nUse when the user asks to search the web.\n",
    );
    assert.deepStrictEqual(data.metadata, {
      openclaw: { homepage: "https://example.com" },
    });
  });

  await check("parseSkill: name defaults to dir basename", () => {
    const s = parseSkill(`---\ndescription: d\n---\nbody`, {
      path: "/tmp/foo/SKILL.md",
      dir: "/tmp/foo",
    });
    assert.strictEqual(s.name, "foo");
    assert.strictEqual(s.description, "d");
    assert.strictEqual(s.body, "body");
  });

  await check("loadSkillsFromDir: missing dir → empty", () => {
    assert.deepStrictEqual(loadSkillsFromDir("/no/such/dir/here"), []);
  });

  await check("loadSkillsFromDir: directory + legacy forms", () => {
    const root = fixtureDir();
    const skills = loadSkillsFromDir(join(root, ".agents", "skills"));
    const byName = new Map(skills.map((s) => [s.name, s]));
    assert.strictEqual(skills.length, 3);
    assert.ok(byName.has("review"));
    assert.ok(byName.has("run-tests")); // name defaulted from dir
    assert.ok(byName.has("greet")); // legacy single file
    assert.deepStrictEqual(byName.get("review")!.allowedTools, [
      "read",
      "grep",
      "bash",
    ]);
    assert.deepStrictEqual(byName.get("run-tests")!.allowedTools, ["bash"]);
    assert.strictEqual(byName.get("review")!.model, "deepseek-v4-pro");
  });

  await check("discoverSkills: project layer, no user dir", () => {
    const root = fixtureDir();
    const reg = discoverSkills({ cwd: root, includeProject: true });
    assert.strictEqual(reg.size, 3);
    assert.ok(reg.has("review"));
  });

  await check("discoverSkills: no scope enabled → empty", () => {
    assert.strictEqual(discoverSkills({ cwd: fixtureDir() }).size, 0);
  });

  await check("discoverSkills: scans cwd up to git root, nearest wins", () => {
    const repo = mkdtempSync(join(tmpdir(), "ds-forge-skills-repo-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    const rootSkill = join(repo, ".agents", "skills", "shared");
    const sub = join(repo, "packages", "api");
    const subSkill = join(sub, ".agents", "skills", "shared");
    mkdirSync(rootSkill, { recursive: true });
    mkdirSync(subSkill, { recursive: true });
    writeFileSync(join(rootSkill, "SKILL.md"), `---\nname: shared\n---\nROOT`);
    writeFileSync(join(subSkill, "SKILL.md"), `---\nname: shared\n---\nSUB`);

    const reg = discoverSkills({ cwd: sub, includeProject: true });
    assert.strictEqual(reg.get("shared")!.body, "SUB");
  });

  await check("discoverSkills: extra dirs win on name collision", () => {
    const a = mkdtempSync(join(tmpdir(), "ds-forge-skills-a-"));
    const b = mkdtempSync(join(tmpdir(), "ds-forge-skills-b-"));
    for (const [dir, body] of [
      [a, "from-a"],
      [b, "from-b"],
    ] as const) {
      const sd = join(dir, "dup");
      mkdirSync(sd, { recursive: true });
      writeFileSync(join(sd, "SKILL.md"), `---\nname: dup\n---\n${body}`);
    }
    // a listed first → a wins.
    const reg = discoverSkills({ dirs: [a, b], cwd: "/no/project" });
    assert.strictEqual(reg.get("dup")!.body, "from-a");
  });

  await check("toSkillRegistry: explicit dirs do not expand ambient scopes", () => {
    const ambient = fixtureDir();
    const explicit = mkdtempSync(join(tmpdir(), "ds-forge-skills-explicit-"));
    const only = join(explicit, "only");
    mkdirSync(only, { recursive: true });
    writeFileSync(join(only, "SKILL.md"), `---\nname: only\n---\nONLY`);

    const reg = toSkillRegistry([explicit], ambient);
    assert.deepStrictEqual(reg.list().map((s) => s.name), ["only"]);
  });

  await check("renderSkill: ${arguments} and ${SKILL_DIR}", () => {
    const reg = discoverSkills({ cwd: fixtureDir(), includeProject: true });
    const review = reg.get("review")!;
    const out = renderSkill(review, "src/auth.ts src/db.ts");
    assert.ok(out.includes("src/auth.ts src/db.ts"));
    assert.ok(out.includes(review.dir));
    assert.ok(!out.includes("${arguments}"));
  });

  await check("renderSkill: named args join + substitution", () => {
    const s = parseSkill(`---\nname: n\n---\nHi \${who}, args=\${arguments}`, {
      path: "/t/SKILL.md",
      dir: "/t",
    });
    const out = renderSkill(s, { who: "Sam" });
    assert.ok(out.includes("Hi Sam"));
    assert.ok(out.includes("args=Sam"));
  });

  await check("skillsCatalog: empty registry → empty string", () => {
    assert.strictEqual(skillsCatalog(new SkillRegistry()), "");
  });

  await check("skillsCatalog: lists name + description", () => {
    const reg = discoverSkills({ cwd: fixtureDir(), includeProject: true });
    const cat = skillsCatalog(reg);
    assert.ok(cat.includes("- review: Review code changes"));
    assert.ok(cat.includes("`skill`"));
  });

  await check("skillsCatalog: folds multiline descriptions onto one line", () => {
    const registry = new SkillRegistry();
    registry.register(
      parseSkill(`---\nname: reach\ndescription: >\n  Search the web.\n  Read URLs.\n---\nGo.`, {
        path: "/tmp/reach/SKILL.md",
        dir: "/tmp/reach",
      }),
    );
    assert.ok(skillsCatalog(registry).includes("- reach: Search the web. Read URLs."));
  });

  await check("skillTool: loads body + header, unknown → list", async () => {
    const reg = discoverSkills({ cwd: fixtureDir(), includeProject: true });
    const t = skillTool(reg);
    const ok = await t.execute({ name: "review", arguments: "x.ts" });
    assert.ok(ok.includes("# Skill: review"));
    assert.ok(ok.includes(`Skill directory: ${reg.get("review")!.dir}`));
    assert.ok(ok.includes("Resolve relative paths"));
    assert.ok(ok.includes("Intended tools: read, grep, bash"));
    assert.ok(ok.includes("x.ts"));

    const miss = await t.execute({ name: "nope" });
    assert.ok(miss.startsWith("Error: unknown skill 'nope'"));
    assert.ok(miss.includes("review"));
  });

  await check("Forge: skills register `skill` tool + inject catalog", () => {
    // Hermetic: pass a prebuilt registry (a bare dir string would also pull in
    // the machine's ~/.agents/skills via includeUser discovery).
    const registry = discoverSkills({ cwd: fixtureDir(), includeProject: true });
    const forge = new Forge({
      apiKey: "test-key",
      system: "You are helpful.",
      skills: registry,
    });
    assert.ok(forge.tools.has("skill"), "skill tool registered");
    assert.strictEqual(forge.skills?.size, 3);
    const sys = forge.context.messages.find((m) => m.role === "system");
    assert.ok(sys?.content?.includes("You are helpful."));
    assert.ok(sys?.content?.includes("## Available skills"));
    assert.ok(sys?.content?.includes("- review:"));
  });

  await check("AgentSession: skills pass through to Forge", () => {
    const registry = discoverSkills({ cwd: fixtureDir(), includeProject: true });
    const session = AgentSession.open({
      apiKey: "test-key",
      system: "S",
      agentsMd: false,
      skills: registry,
    });
    assert.ok(session.forge.tools.has("skill"));
    assert.strictEqual(session.forge.skills?.size, 3);
  });

  await check("Forge: empty skills → no skill tool, no catalog", () => {
    const forge = new Forge({
      apiKey: "test-key",
      system: "S",
      skills: new SkillRegistry(),
    });
    assert.ok(!forge.tools.has("skill"));
    assert.strictEqual(forge.skills, undefined);
    const sys = forge.context.messages.find((m) => m.role === "system");
    assert.strictEqual(sys?.content, "S");
  });

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Test suite error:", e);
  process.exit(1);
});
