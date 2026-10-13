import assert from "node:assert/strict";
import { test } from "node:test";
import { formatApprovalQuestion, interpretReply, toolSignature } from "./permission-server.js";

test("formatApprovalQuestion names the tool and includes the input as JSON", () => {
  const question = formatApprovalQuestion("Bash", { command: "rm -rf /tmp/x" });
  assert.match(question, /Bash/);
  assert.match(question, /rm -rf \/tmp\/x/);
  assert.match(question, /approve.*deny/s);
});

test("interpretReply treats 'approve' as allow", () => {
  assert.equal(interpretReply("approve").behavior, "allow");
});

test("interpretReply treats 'allow' and 'yes' as allow too", () => {
  assert.equal(interpretReply("allow, go ahead").behavior, "allow");
  assert.equal(interpretReply("yes").behavior, "allow");
});

test("interpretReply treats anything else as deny, carrying the reply as the reason", () => {
  const result = interpretReply("deny, that touches prod");
  assert.equal(result.behavior, "deny");
  assert.equal((result as { message: string }).message, "deny, that touches prod");
});

test("interpretReply falls back to a generic deny message for an empty reply", () => {
  const result = interpretReply("   ");
  assert.equal(result.behavior, "deny");
  assert.equal((result as { message: string }).message, "operator denied this action");
});

test("interpretReply treats plain 'approve' as a one-time allow, not remembered", () => {
  const result = interpretReply("approve");
  assert.equal(result.behavior, "allow");
  assert.equal((result as { remember?: boolean }).remember, false);
});

test("interpretReply treats 'approve always' as allow + remember", () => {
  const result = interpretReply("approve always");
  assert.equal(result.behavior, "allow");
  assert.equal((result as { remember?: boolean }).remember, true);
});

test("interpretReply is case-insensitive for the always marker", () => {
  const result = interpretReply("Approve Always");
  assert.equal((result as { remember?: boolean }).remember, true);
});

test("toolSignature distinguishes git subcommands, not just the binary", () => {
  // Regression test for a review finding: grouping by first word alone made
  // approving `git commit` also silently auto-allow a later `git push` or
  // `git reset --hard` in the same turn - a real permission-boundary gap.
  assert.equal(toolSignature("Bash", { command: "git commit -m 'x'" }), "Bash:git commit -m");
  assert.equal(toolSignature("Bash", { command: "git push origin main" }), "Bash:git push origin");
  assert.notEqual(
    toolSignature("Bash", { command: "git commit -m 'x'" }),
    toolSignature("Bash", { command: "git push origin main" }),
  );
});

test("toolSignature distinguishes gh subcommands", () => {
  assert.notEqual(
    toolSignature("Bash", { command: "gh pr create --title x" }),
    toolSignature("Bash", { command: "gh pr merge --squash" }),
  );
});

test("toolSignature falls back to the plain tool name for non-Bash tools", () => {
  assert.equal(toolSignature("Edit", { file_path: "/a" }), "Edit");
  assert.equal(toolSignature("Write", { file_path: "/a" }), "Write");
});

test("toolSignature falls back to the plain tool name when Bash input has no command", () => {
  assert.equal(toolSignature("Bash", {}), "Bash");
  assert.equal(toolSignature("Bash", undefined), "Bash");
});
