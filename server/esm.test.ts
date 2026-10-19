import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

it("loads the compiled API with native Node ESM, without a TypeScript loader or database initialization", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const directory = mkdtempSync(join(tmpdir(), "xai-native-esm-"));
  try {
    const configPath = join(root, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
    if (parsed.errors.length) {
      throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
    }

    // Preserve source paths and the actual compiler options: bundler resolution
    // must not hide imports that native Node cannot resolve after transpilation.
    for (const area of ["api", "server", "shared"]) {
      const sources = ts.sys.readDirectory(join(root, area), [".ts", ".tsx"], ["**/*.test.ts", "**/*.test.tsx"]);
      for (const source of sources) {
        if (source.endsWith(".d.ts")) continue;
        const output = ts.transpileModule(readFileSync(source, "utf8"), {
          fileName: source,
          compilerOptions: parsed.options,
        });
        const target = join(directory, relative(root, source).replace(/\.tsx?$/, ".js"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, output.outputText);
      }
    }
    copyFileSync(join(root, "package.json"), join(directory, "package.json"));
    mkdirSync(join(directory, "shared", "data"), { recursive: true });
    for (const source of ts.sys.readDirectory(join(root, "shared", "data"), [".json"], undefined, ["*.json"])) {
      copyFileSync(source, join(directory, "shared", "data", relative(join(root, "shared", "data"), source)));
    }
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "junction");

    // Importing creates the default handler, but never invokes it or opens a DB.
    // Clear NODE_OPTIONS so inherited tsx/loader hooks cannot mask ESM failures.
    const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      const entry = await import(pathToFileURL(process.argv[1]).href);
      assert.equal(typeof entry.default, "function");
      assert.equal(typeof entry.createHandler, "function");
      console.log("native ESM imports loaded");
    `, join(directory, "api", "index.js")], {
      cwd: directory,
      env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(stdout.trim()).toBe("native ESM imports loaded");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
