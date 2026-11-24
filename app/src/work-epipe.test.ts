// Spawns the real CLI against a stub pinboard with its stdout already closed,
// the deterministic form of `work task show <id> | head -1`. The writes after
// the close must end the process quietly (exit 0), not with a `write EPIPE`
// stack.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

function stubPinboard(): Promise<Server> {
  const task = {
    id: 7,
    projectId: 1,
    title: "Example story",
    description: "line\n".repeat(50),
    taskType: "story",
    status: "in_progress",
    executorMode: "agent",
    priority: 1,
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
  const comments = Array.from({ length: 500 }, (_, i) => ({
    id: i,
    authorType: "human",
    authorName: "op",
    body: `comment ${i} `.repeat(20),
    createdAt: "2026-01-01T00:00:00Z",
  }));
  const children = Array.from({ length: 50 }, (_, i) => ({ ...task, id: 100 + i, taskType: "task", title: `child ${i}` }));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let body: unknown = [];
    if (url.pathname === "/api/tasks/7") body = task;
    else if (url.pathname === "/api/tasks/7/comments") body = comments;
    else if (url.pathname === "/api/tasks" && url.searchParams.has("parentTaskId")) body = children;
    // Every /relations call answers [] - no parent, no depends_on.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("work exits 0 without a stack trace when stdout closes early (EPIPE)", { timeout: 30_000 }, async () => {
  const server = await stubPinboard();
  try {
    const { port } = server.address() as AddressInfo;
    const child = spawn(process.execPath, ["--import", "tsx", "src/work.ts", "task", "show", "7"], {
      cwd: APP_DIR,
      env: { ...process.env, PINBOARD_URL: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // Close the read end before the CLI has written anything, like a reader
    // that exits at once (`| true`). Closing it on the first chunk instead
    // races the CLI's writes and only sometimes hits the crash.
    child.stdout.destroy();
    const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
    assert.equal(stderr, "", `unexpected stderr:\n${stderr}`);
    assert.equal(code, 0);
  } finally {
    server.close();
  }
});
