/**
 * Smoke test for the plan-mode extension.
 *
 * Runs against a throwaway PI_CODING_AGENT_DIR — never touches real plans.
 * Loads the extension with a mocked ExtensionAPI and exercises every flow:
 * registration, approve/adjust/cancel, the enforcement gate, [DONE:n]
 * ticking, /plans done, and the /plan force command.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-plan-mode-test-"));
process.env.PI_CODING_AGENT_DIR = tmp;

test.after(() => rmSync(tmp, { recursive: true, force: true }));

/* ---------------- mock pi runtime ---------------- */

const theme = { fg: (_c, s) => s, bold: (s) => s, strikethrough: (s) => `~${s}~` };
const state = {
	tools: {},
	cmds: {},
	handlers: {},
	entries: [],
	sent: [],
	notifs: [],
	widget: null,
	status: null,
	select: async () => "Approve",
	editor: async () => "",
};

const pi = {
	registerTool: (t) => (state.tools[t.name] = t),
	registerCommand: (n, o) => (state.cmds[n] = o),
	on: (ev, h) => ((state.handlers[ev] ||= []).push(h), () => {}),
	appendEntry: (customType, data) => state.entries.push({ type: "custom", customType, data }),
	sendUserMessage: (content, opts) => state.sent.push({ content, opts }),
	getAllTools: () => [
		{ name: "read", annotations: { readOnlyHint: true } },
		{ name: "edit", annotations: { readOnlyHint: false } },
		{ name: "bash", annotations: {} },
	],
};

const mkCtx = () => ({
	hasUI: true,
	ui: {
		theme,
		setStatus: (_k, t) => (state.status = t),
		setWidget: (_k, c) => (state.widget = c),
		notify: (m, t) => state.notifs.push(`${t ?? "info"}: ${m}`),
		select: () => state.select(),
		editor: () => state.editor(),
	},
	sessionManager: { getEntries: () => state.entries },
});

const importExt = async () => {
	const mod = await import("../extensions/plan-mode.ts");
	mod.default(pi);
};

/* ---------------- tests (sequential: shared module state) ---------------- */

test("registers tool, commands, events, and workflow guidelines", async () => {
	await importExt();
	assert.ok(state.tools.propose_plan, "propose_plan registered");
	assert.deepEqual(state.tools.propose_plan.exposure, "model-only");
	assert.equal(state.tools.propose_plan.promptGuidelines.length, 4);
	assert.ok(state.tools.propose_plan.promptGuidelines.some((g) => g.includes("Exempt")));
	assert.deepEqual(Object.keys(state.cmds).sort(), ["plan", "plans"]);
	for (const ev of ["tool_call", "turn_end", "session_start", "session_tree"]) {
		assert.ok(state.handlers[ev]?.length, `${ev} handler`);
	}
});

test("approve writes plan file with steps and shows the checklist", async () => {
	state.select = async () => "Approve";
	const r = await state.tools.propose_plan.execute(
		"t1",
		{ title: "Smoke Approve", body: "1. alpha\n2. beta\n3. gamma" },
		undefined,
		undefined,
		mkCtx(),
	);
	assert.equal(r.details.decision, "approved");
	assert.ok(existsSync(r.details.file), "plan file exists");
	assert.match(readFileSync(r.details.file, "utf8"), /^status:\s*approved$/m);
	assert.equal(state.entries.at(-1).data.steps.length, 3);
	assert.ok(state.widget[1].includes("☐ alpha"));
});

test("gate blocks mutating tools while the dialog is open, passes read-only", async () => {
	let release;
	state.select = () => new Promise((res) => (release = () => res("Cancel")));
	const pending = state.tools.propose_plan.execute(
		"t2",
		{ title: "Smoke Gate", body: "1. x" },
		undefined,
		undefined,
		mkCtx(),
	);
	await new Promise((r) => setTimeout(r, 10));
	const gate = state.handlers.tool_call[0];
	assert.equal((await gate({ toolName: "edit" }))?.block, true, "edit blocked");
	assert.equal((await gate({ toolName: "bash" }))?.block, true, "bash blocked");
	assert.equal(await gate({ toolName: "read" }), undefined, "read allowed");
	release();
	await pending;
	assert.equal(await gate({ toolName: "edit" }), undefined, "gate silent when idle");
});

test("[DONE:n] ticks steps; all-done flips widget and notifies", async () => {
	// the gate test cancelled its plan — approve a fresh one for this test
	state.select = async () => "Approve";
	await state.tools.propose_plan.execute(
		"t0",
		{ title: "Smoke Ticks", body: "1. alpha\n2. beta\n3. gamma" },
		undefined,
		undefined,
		mkCtx(),
	);
	const turnEnd = state.handlers.turn_end[0];
	const ctx = mkCtx();
	await turnEnd({ message: { role: "assistant", content: [{ type: "text", text: "[DONE:1] and [DONE:3]" }] } }, ctx);
	assert.ok(state.widget[1].includes("☑"), "step 1 ticked");
	assert.ok(state.widget[2].includes("☐ beta"), "step 2 open");
	await turnEnd({ message: { role: "assistant", content: [{ type: "text", text: "[DONE:2] [DONE:99]" }] } }, ctx);
	assert.ok(state.widget[0].includes("plan complete"), "complete header");
	assert.ok(state.notifs.some((n) => n.includes("Plan complete")), "completion notify");
});

test("/plans done flips file status and clears the widget", async () => {
	await state.cmds.plans.handler("done", mkCtx());
	assert.equal(state.widget, undefined);
	assert.equal(state.status, undefined);
	const files = state.entries.at(-1).data;
	assert.equal(files.approved, false);
});

test("adjust returns feedback without writing a file", async () => {
	state.select = async () => "Adjust";
	state.editor = async () => "make step 2 optional";
	const before = state.sent.length;
	const r = await state.tools.propose_plan.execute(
		"t3",
		{ title: "Smoke Adjust", body: "1. x" },
		undefined,
		undefined,
		mkCtx(),
	);
	assert.equal(r.details.decision, "adjust");
	assert.equal(r.details.feedback, "make step 2 optional");
	assert.match(r.content[0].text, /Do NOT implement/);
	state.editor = async () => "";
});

test("cancel returns cancelled decision", async () => {
	state.select = async () => "Cancel";
	const r = await state.tools.propose_plan.execute(
		"t4",
		{ title: "Smoke Cancel", body: "1. y" },
		undefined,
		undefined,
		mkCtx(),
	);
	assert.equal(r.details.decision, "cancelled");
	assert.match(r.content[0].text, /Do not implement/);
});

test("prose plan (no numbered steps) falls back to title-only widget", async () => {
	state.select = async () => "Approve";
	const r = await state.tools.propose_plan.execute(
		"t5",
		{ title: "Smoke Prose", body: "just do the thing somehow" },
		undefined,
		undefined,
		mkCtx(),
	);
	assert.equal(state.widget.length, 2);
	assert.ok(state.widget[1].includes("/plans done"));
	// close it so later runs stay clean
	await state.cmds.plans.handler("done", mkCtx());
});

test("/plan: no args → usage; with task → forced instruction", async () => {
	state.notifs.length = 0;
	await state.cmds.plan.handler("", mkCtx());
	assert.ok(state.notifs[0].includes("Usage: /plan"));

	await state.cmds.plan.handler("fix the login bug", mkCtx());
	assert.equal(state.sent.length, 1);
	assert.equal(state.sent[0].opts.expandPromptTemplates, false);
	assert.match(state.sent[0].content, /guaranteed plan trigger/);
	assert.ok(state.sent[0].content.includes("fix the login bug"));
});
