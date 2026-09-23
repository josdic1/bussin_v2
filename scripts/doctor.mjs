import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let failed = false;

function check(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status === 0) {
    console.log(`✓ ${label}`);
  } else {
    failed = true;
    console.log(`✗ ${label}`);
    console.log(
      (result.stderr || result.stdout || result.error?.message).trim(),
    );
  }
}

console.log(`Node ${process.version}`);

if (existsSync(new URL("../node_modules", import.meta.url))) {
  console.log("✓ Dependencies installed");
} else {
  failed = true;
  console.log("✗ Dependencies missing — run npm install");
}

check("npm available", "npm", ["--version"]);
check("Shared package builds", "npm", ["run", "build", "-w", "@bussin/shared"]);

process.exitCode = failed ? 1 : 0;
