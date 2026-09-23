import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = spawnSync("npm", ["run", "build", "-w", "@bussin/shared"], {
  cwd: root,
  stdio: "inherit"
});
if (build.error || build.status !== 0) process.exit(build.status || 1);

const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
  }
  const timer = setTimeout(() => {
    for (const child of children) {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    }
    process.exit(code);
  }, 2000);
  timer.unref();
  Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("close", resolve);
  }))).then(() => process.exit(code));
}

function start(label, args) {
  const child = spawn("npm", args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  for (const stream of ["stdout", "stderr"]) {
    createInterface({ input: child[stream] }).on("line", (line) => {
      const color = { frontend: "\x1b[95m", server: "\x1b[92m", shared: "\x1b[93m" }[label];
      console.log(`${color}[${label}]\x1b[0m ${line}`);
    });
  }
  child.on("error", (error) => {
    console.error(`[${label}] ${error.message}`);
    stop(1);
  });
  child.on("close", (code) => {
    if (!stopping) {
      console.error(`[${label}] exited (${code ?? "signal"}); stopping all services`);
      stop(code || 1);
    }
  });
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

start("shared", ["exec", "-w", "@bussin/shared", "--", "tsc", "--watch", "--preserveWatchOutput"]);
start("server", ["run", "dev", "-w", "@bussin/server"]);
start("frontend", ["run", "dev", "-w", "@bussin/frontend", "--", "--strictPort"]);
console.log("Bussin started. Press Ctrl-C to stop all three.");
