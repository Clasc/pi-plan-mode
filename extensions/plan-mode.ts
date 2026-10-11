/**
 * plan-mode.ts — approval-gated plan workflow for pi
 *
 * Workflow (see ~/.pi/agent/AGENTS.md):
 *   1. For non-trivial tasks the model calls `propose_plan` (title + markdown body)
 *      instead of writing the plan as plain chat text.
 *   2. The tool opens an Approve / Adjust / Cancel dialog and BLOCKS until decided.
 *   3. Approve → the plan is written to ~/.pi/agent/plans/YYYY-MM-DD-<slug>.md
 *      with `status: approved`, and the model is told to implement.
 *      Adjust  → the user's feedback is returned to the model, which re-proposes.
 *      Cancel  → the model must not implement.
 *   4. The approved plan's numbered steps render as a checklist widget (☑/☐,
 *      max 6 visible lines). The agent emits [DONE:n] tags as each step
 *      finishes; turn_end ticks them in the widget.
 *   5. After reporting, `/plans done` flips the plan to `status: done` and
 *      clears the status widget.
 *   6. `/plan <task>` forces the plan flow: it injects an instruction that
 *      skips the "is a plan needed?" judgment (alignment still happens).
 *
 * Enforcement: while the approval dialog is open, any tool call whose tool does
 * not declare `annotations.readOnlyHint: true` is blocked ("waiting for plan
 * approval"). With no plan pending everything is silent, so trivial one-step
 * fixes stay friction-free.
 *
 * State lives in transcript entries (survives resume); approved plan files in
 * ~/.pi/agent/plans/ survive sessions. Unfinished plans are surfaced on
 * session start.
 *
 * Install: ~/.pi/agent/extensions/plan-mode.ts (auto-loaded, hot-reloadable).
 *
 * Fully self-contained: the workflow rules travel with the tool via
 * `promptGuidelines` (appended to the system prompt while the tool is
 * active), and the plans dir honors PI_CODING_AGENT_DIR. Copying this single
 * file to another pi install is a complete setup.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const PLANS_DIR = path.join(AGENT_DIR, "plans");
const STATE_ENTRY = "plan-mode";
const MAX_VISIBLE_STEPS = 6;

interface PlanStep {
	n: number;
	text: string;
	done: boolean;
}

interface PlanState {
	approved: boolean;
	title?: string;
	file?: string;
	steps?: PlanStep[];
}

interface PlanDetails {
	decision: "approved" | "adjust" | "cancelled";
	title: string;
	file?: string;
	feedback?: string;
}

const PlanParams = Type.Object({
	title: Type.String({ description: "Short one-line title of the plan (shown in the approval dialog)" }),
	body: Type.String({
		description:
			"The full plan in markdown: numbered steps, files touched, and expected outcome. This exact text is persisted on approval.",
	}),
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "plan"
	);
}

function today(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function writePlanFile(title: string, body: string): Promise<string> {
	await fs.mkdir(PLANS_DIR, { recursive: true });
	const base = `${today()}-${slugify(title)}`;
	let file = path.join(PLANS_DIR, `${base}.md`);
	for (let i = 2; ; i++) {
		try {
			await fs.access(file);
			file = path.join(PLANS_DIR, `${base}-${i}.md`);
		} catch {
			break;
		}
	}
	const content = `---\nstatus: approved\ndate: ${today()}\ntitle: ${title}\n---\n\n${body.trim()}\n`;
	await fs.writeFile(file, content, "utf8");
	return file;
}

/** Extract numbered steps ("1. …" / "1) …") from a plan body. Empty if none. */
function parseSteps(body: string): PlanStep[] {
	const steps: PlanStep[] = [];
	for (const m of body.matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)) {
		const n = Number(m[1]);
		if (!Number.isFinite(n)) continue;
		const text = m[2]
			.replace(/\*{1,2}/g, "")
			.replace(/`/g, "")
			.trim();
		if (text) steps.push({ n, text, done: false });
	}
	return steps;
}

async function listPlanFiles(): Promise<{ name: string; status: string; title: string }[]> {
	let names: string[];
	try {
		names = await fs.readdir(PLANS_DIR);
	} catch {
		return [];
	}
	const out: { name: string; status: string; title: string }[] = [];
	for (const name of names.filter((n) => n.endsWith(".md")).sort().reverse()) {
		try {
			const text = await fs.readFile(path.join(PLANS_DIR, name), "utf8");
			const status = text.match(/^status:\s*(\w+)/m)?.[1] ?? "?";
			const title = text.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? name;
			out.push({ name, status, title });
		} catch {
			/* skip unreadable files */
		}
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* extension                                                           */
/* ------------------------------------------------------------------ */

export default function planModeExtension(pi: ExtensionAPI): void {
	let awaitingDecision = false;
	let state: PlanState = { approved: false };
	let pendingTitle: string | undefined;

	/* ---------------- state persistence ---------------- */

	const persist = (): void => {
		pi.appendEntry(STATE_ENTRY, { ...state });
	};

	const restoreState = (ctx: ExtensionContext): void => {
		const entries = ctx.sessionManager.getEntries() as { type?: string; customType?: string; data?: PlanState }[];
		const last = [...entries].reverse().find((e) => e.type === "custom" && e.customType === STATE_ENTRY);
		state = last?.data ?? { approved: false };
	};

	/* ---------------- widget / status ---------------- */

	const updateUi = (ctx: ExtensionContext): void => {
		if (awaitingDecision && pendingTitle) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", `⏸ plan: ${pendingTitle}`));
			ctx.ui.setWidget("plan-mode", [
				ctx.ui.theme.fg("warning", `⏸ awaiting approval: ${pendingTitle}`),
				ctx.ui.theme.fg("muted", "decide in the dialog (Approve / Adjust / Cancel)"),
			]);
		} else if (state.approved && state.title) {
			const th = ctx.ui.theme;
			const steps = state.steps ?? [];
			const allDone = steps.length > 0 && steps.every((s) => s.done);
			ctx.ui.setStatus(
				"plan-mode",
				allDone
					? th.fg("success", `✓ plan complete: ${state.title}`)
					: th.fg("success", `✓ plan: ${state.title}`),
			);
			const lines = [
				allDone
					? th.fg("success", `✓ plan complete: ${state.title}`)
					: th.fg("success", `✓ approved: ${state.title}`),
			];
			if (steps.length > 0) {
				const visible = steps.slice(0, MAX_VISIBLE_STEPS);
				for (const s of visible) {
					lines.push(
						s.done
							? th.fg("success", "☑ ") + th.fg("muted", th.strikethrough(s.text))
							: th.fg("muted", `☐ ${s.text}`),
					);
				}
				if (steps.length > visible.length) {
					lines.push(th.fg("muted", `… +${steps.length - visible.length} more`));
				}
				lines.push(allDone ? th.fg("accent", "run /plans done") : th.fg("muted", "[DONE:n] ticks steps"));
			} else {
				lines.push(th.fg("muted", "run /plans done when it is implemented"));
			}
			ctx.ui.setWidget("plan-mode", lines);
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
			ctx.ui.setWidget("plan-mode", undefined);
		}
	};

	/* ---------------- the propose_plan tool ---------------- */

	pi.registerTool({
		name: "propose_plan",
		label: "Plan",
		description:
			"Propose a plan and ask the user for approval before implementing. For any non-trivial task: " +
			"after aligning on requirements, call this tool with a short title and the full markdown plan " +
			"(steps, files touched, expected outcome). The call blocks until the user approves, adjusts, or " +
			"the plan. Implement ONLY when the result says the plan was approved; on 'adjust' revise using " +
			"the feedback and propose again; on 'cancel' do not implement.",
		promptGuidelines: [
			"Before implementing any non-trivial task (file edits, state-changing commands, multi-step work): first align on what needs to be done — ask questions until your view and the user's match — then present the plan with the propose_plan tool (short title + full markdown plan: steps, files touched, expected outcome). Do not present plans as plain chat text.",
			"Implement ONLY when propose_plan returns an approved decision. On 'adjust', revise using the user's feedback and propose_plan again. On 'cancel', do not implement; ask what the user wants instead.",
			"Exempt from planning (just do them): read-only exploration and file inspection, questions / Q&A, and trivial single-step fixes.",
			"While implementing an approved plan, include [DONE:n] in your reply as each numbered step n completes — this ticks the plan checklist widget. After implementing, report what was done against the plan and prompt: run /plans done.",
		],
		exposure: "model-only",
		parameters: PlanParams,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error(
					"propose_plan requires interactive mode (an approval dialog must be shown). " +
						"In non-interactive runs, proceed without planning.",
				);
			}

			awaitingDecision = true;
			pendingTitle = params.title;
			updateUi(ctx);

			try {
				const choice = await ctx.ui.select(`Plan: ${params.title}`, ["Approve", "Adjust", "Cancel"]);

				if (choice === "Approve") {
					const file = await writePlanFile(params.title, params.body);
					state = { approved: true, title: params.title, file, steps: parseSteps(params.body) };
					persist();
					const details: PlanDetails = { decision: "approved", title: params.title, file };
					return {
						content: [
							{
								type: "text",
								text:
									`Plan APPROVED by the user. Implement it now. ` +
									`Saved to ${file}. ` +
									`Include [DONE:n] in your reply as each numbered step n completes ` +
									`(this ticks the checklist widget). ` +
									`When finished, report against the plan and prompt: run /plans done.`,
							},
						],
						details,
					};
				}

				if (choice === "Adjust") {
					const feedback = await ctx.ui.editor("What should change in the plan?", params.body);
					const trimmed = feedback?.trim() ?? "";
					if (!trimmed || trimmed === params.body.trim()) {
						const details: PlanDetails = { decision: "adjust", title: params.title, feedback: "" };
						return {
							content: [
								{
									type: "text",
									text: "The user selected Adjust but made no changes. Ask them what they want different.",
								},
							],
							details,
						};
					}
					const details: PlanDetails = { decision: "adjust", title: params.title, feedback: trimmed };
					return {
						content: [
							{
								type: "text",
								text:
									`The user wants the plan adjusted. Do NOT implement yet. ` +
									`Revise the plan using this feedback and propose_plan again:\n\n${trimmed}`,
							},
						],
						details,
					};
				}

				// Cancel (or dialog dismissed)
				state = { approved: false };
				persist();
				const details: PlanDetails = { decision: "cancelled", title: params.title };
				return {
					content: [
						{
							type: "text",
							text:
								"Plan CANCELLED by the user. Do not implement. " +
								"Ask what they would like to do instead.",
						},
					],
					details,
				};
			} finally {
				awaitingDecision = false;
				pendingTitle = undefined;
				updateUi(ctx);
			}
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("propose plan ")) + theme.fg("muted", args.title), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as PlanDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			switch (details.decision) {
				case "approved":
					return new Text(theme.fg("success", "✓ approved ") + theme.fg("muted", details.title), 0, 0);
				case "adjust":
					return new Text(theme.fg("warning", "✎ adjust ") + theme.fg("muted", details.title), 0, 0);
				case "cancelled":
					return new Text(theme.fg("error", "✗ cancelled ") + theme.fg("muted", details.title), 0, 0);
			}
		},
	});

	/* ---------------- enforcement gate ---------------- */

	pi.on("tool_call", async (event) => {
		if (!awaitingDecision) return undefined;
		const tool = pi.getAllTools().find((t) => t.name === event.toolName);
		if (tool?.annotations?.readOnlyHint === true) return undefined;
		return {
			block: true,
			reason: `plan-mode: a plan ("${pendingTitle}") is awaiting the user's approval — wait for the decision`,
		};
	});

	/* ---------------- [DONE:n] tick tracking ---------------- */

	pi.on("turn_end", async (event, ctx) => {
		if (!state.approved || !state.steps || state.steps.length === 0) return;
		const msg = event.message as { role?: string; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;
		const text = (msg.content as { type?: string; text?: string }[])
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
		let changed = 0;
		for (const m of text.matchAll(/\[DONE:(\d+)\]/gi)) {
			const step = state.steps.find((s) => s.n === Number(m[1]));
			if (step && !step.done) {
				step.done = true;
				changed++;
			}
		}
		if (changed > 0) {
			persist();
			updateUi(ctx);
			if (state.steps.every((s) => s.done)) {
				ctx.ui.notify(`Plan complete: ${state.title} — run /plans done`, "info");
			}
		}
	});

	/* ---------------- /plan (force a plan) ---------------- */

	pi.registerCommand("plan", {
		description: "Force the plan flow for a task: /plan <task description>",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /plan <task description>", "warning");
				return;
			}
			pi.sendUserMessage(
				`The user invoked /plan to force a plan for:\n\n${task}\n\n` +
					`This is a guaranteed plan trigger: skip judging whether a plan is needed — it is. ` +
					`Align first (brief clarifying questions if genuinely needed), then call propose_plan ` +
					`with the full plan (steps, files touched, expected outcome). ` +
					`Do NOT implement before the user approves.`,
				{ expandPromptTemplates: false },
			);
		},
	});

	/* ---------------- /plans command ---------------- */

	pi.registerCommand("plans", {
		description: "List saved plans; '/plans done' marks the latest approved plan as done",
		handler: async (args, ctx) => {
			const sub = args.trim();

			if (sub === "done") {
				let file = state.approved ? state.file : undefined;
				if (!file) {
					const approved = (await listPlanFiles()).find((p) => p.status === "approved");
					if (approved) file = path.join(PLANS_DIR, approved.name);
				}
				if (!file) {
					ctx.ui.notify("No approved plan to close.", "warning");
					return;
				}
				try {
					const text = await fs.readFile(file, "utf8");
					await fs.writeFile(file, text.replace(/^status:\s*approved$/m, "status: done"), "utf8");
				} catch (err) {
					ctx.ui.notify(`Failed to update ${path.basename(file)}: ${String(err)}`, "error");
					return;
				}
				state = { approved: false };
				persist();
				updateUi(ctx);
				ctx.ui.notify(`✓ Plan marked done: ${path.basename(file)}`, "info");
				return;
			}

			const plans = await listPlanFiles();
			if (plans.length === 0) {
				ctx.ui.notify(`No plans yet in ${PLANS_DIR}`, "info");
				return;
			}
			const badge = (s: string): string =>
				s === "done" ? "✓" : s === "approved" ? "●" : s === "proposed" ? "○" : "?";
			const lines = plans.map((p) => `${badge(p.status)} ${p.title}  (${p.name})`);
			if (state.approved && state.title && (state.steps?.length ?? 0) > 0) {
				lines.push("", `Active plan: ${state.title}`);
				for (const s of state.steps!) {
					lines.push(`  ${s.done ? "☑" : "☐"} ${s.n}. ${s.text}`);
				}
			}
			ctx.ui.notify(`Plans (✓ done · ● approved · ○ proposed):\n${lines.join("\n")}`, "info");
		},
	});

	/* ---------------- session lifecycle ---------------- */

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
		updateUi(ctx);
		if (!ctx.hasUI) return;
		const unfinished = (await listPlanFiles()).filter((p) => p.status === "approved" || p.status === "proposed");
		if (unfinished.length > 0) {
			const lines = unfinished.map((p) => `${p.status === "approved" ? "●" : "○"} ${p.title} (${p.name})`);
			ctx.ui.notify(`Unfinished plans:\n${lines.join("\n")}\nSee /plans for the full list.`, "warning");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
		updateUi(ctx);
	});
}
