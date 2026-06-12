import type { SessionDetail, SessionMeta, ToolCallSummary } from "../types/session.js";

export type PiAgentBoardSession = SessionMeta & {
	detail?: SessionDetail;
};

interface PiAgentBoardOptions {
	generatedAt?: string;
	title?: string;
	from?: string;
	to?: string;
}

function esc(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmtTime(ms: number | undefined): string {
	if (!ms) return "";
	return new Date(ms).toLocaleString("da-DK", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function fmtCost(value: number | undefined): string {
	return typeof value === "number" ? `$${value.toFixed(2)}` : "";
}

function shortId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

function compactPrompt(session: PiAgentBoardSession): string {
	const prompt = session.prompts?.[0] || "";
	return prompt.length > 220 ? `${prompt.slice(0, 220)}…` : prompt;
}

function toolSummary(tools: ToolCallSummary[] | undefined): string {
	if (!tools?.length) return "";
	const counts = new Map<string, number>();
	for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 8)
		.map(([name, count]) => `${name}×${count}`)
		.join(" · ");
}

function inferStatus(session: PiAgentBoardSession): { label: string; className: string; reason: string } {
	const last = session.timeRange?.end || session.timeRange?.start || 0;
	const ageMinutes = last ? (Date.now() - last) / 60000 : Infinity;
	const detail = session.detail;
	const toolErrors = detail?.toolCalls?.filter((t) => /error|fail|exception/i.test(`${t.name} ${t.target ?? ""}`)).length ?? 0;
	const prompt = compactPrompt(session);
	if (/blocked|pim|mangler|venter|failed|error|authorization/i.test(prompt)) {
		return { label: "needs-input", className: "warn", reason: "prompt hints at blocker/input" };
	}
	if (ageMinutes < 20) return { label: "active", className: "ok", reason: "recent activity" };
	if (toolErrors > 0) return { label: "review", className: "warn", reason: "possible tool error markers" };
	return { label: "idle", className: "muted", reason: "no recent activity" };
}

function projectGroups(sessions: PiAgentBoardSession[]): Array<{ project: string; count: number; cost: number; tokens: number }> {
	const groups = new Map<string, { project: string; count: number; cost: number; tokens: number }>();
	for (const session of sessions) {
		const project = session.project || "unknown";
		const group = groups.get(project) ?? { project, count: 0, cost: 0, tokens: 0 };
		group.count++;
		group.cost += session.totalCost ?? 0;
		group.tokens += (session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0) + (session.cacheReadInputTokens ?? 0) + (session.cacheCreationInputTokens ?? 0);
		groups.set(project, group);
	}
	return [...groups.values()].sort((a, b) => b.cost - a.cost || b.count - a.count || a.project.localeCompare(b.project));
}

export function renderPiAgentBoard(sessions: PiAgentBoardSession[], options: PiAgentBoardOptions = {}): string {
	const generatedAt = options.generatedAt ?? new Date().toISOString();
	const sorted = [...sessions].sort((a, b) => (b.timeRange?.end ?? 0) - (a.timeRange?.end ?? 0));
	const totalCost = sorted.reduce((sum, s) => sum + (s.totalCost ?? 0), 0);
	const totalMessages = sorted.reduce((sum, s) => sum + (s.messageCount ?? 0), 0);
	const groups = projectGroups(sorted);

	const rows = sorted.map((session) => {
		const status = inferStatus(session);
		const detail = session.detail;
		const files = (detail?.filesReferenced ?? []).slice(0, 6).map((f) => `<code>${esc(f)}</code>`).join("<br>");
		const summaries = (detail?.assistantSummaries ?? []).slice(0, 2).map((s) => `<div>${esc(s)}</div>`).join("");
		return `<tr>
			<td><span class="pill ${status.className}">${esc(status.label)}</span><br><small>${esc(status.reason)}</small></td>
			<td><code>${esc(shortId(session.sessionId))}</code><br><small>${esc(session.model ?? "")}</small></td>
			<td><strong>${esc(session.projectName)}</strong><br><code>${esc(session.project)}</code></td>
			<td>${esc(fmtTime(session.timeRange?.start))}<br><small>${esc(fmtTime(session.timeRange?.end))}</small></td>
			<td>${esc(compactPrompt(session))}</td>
			<td>${esc(toolSummary(detail?.toolCalls))}<br><small>${files}</small></td>
			<td>${summaries}</td>
			<td class="num">${esc(session.messageCount ?? 0)}<br><small>${esc(fmtCost(session.totalCost))}</small></td>
		</tr>`;
	}).join("\n");

	const groupCards = groups.slice(0, 12).map((g) => `<div class="card"><div class="k">${esc(g.project.split("/").pop() || g.project)}</div><div><code>${esc(g.project)}</code></div><div>${g.count} sessions · ${fmtCost(g.cost)} · ${(g.tokens / 1000).toFixed(0)}K tokens</div></div>`).join("\n");

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(options.title ?? "Pi agent board")}</title>
<style>
:root{color-scheme:dark;--bg:#0f1117;--panel:#171b24;--line:#2a3140;--text:#e7eaf0;--muted:#8f9aad;--accent:#8ab4ff;--ok:#61d394;--warn:#ffd166;--bad:#ff6b6b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#182033,#0f1117 42%);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}header{padding:28px 32px 18px}h1{font-size:32px;margin:0 0 6px}.sub{color:var(--muted)}.metrics{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.metric,.card{background:rgba(23,27,36,.88);border:1px solid var(--line);border-radius:14px;padding:12px 14px}.metric b{display:block;font-size:22px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin:0 32px 24px}.card .k{font-weight:700;margin-bottom:4px}.wrap{padding:0 32px 36px}table{width:100%;border-collapse:separate;border-spacing:0;background:rgba(23,27,36,.92);border:1px solid var(--line);border-radius:16px;overflow:hidden}th,td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{position:sticky;top:0;background:#202637;color:#b9c1d1;font-size:12px;text-transform:uppercase;letter-spacing:.06em}tr:last-child td{border-bottom:0}code{color:#b7f7d4;word-break:break-word}.pill{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:700}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--muted)}small{color:var(--muted)}.num{text-align:right;white-space:nowrap}td:nth-child(5){max-width:360px}td:nth-child(7){max-width:420px}</style>
</head>
<body>
<header>
<h1>${esc(options.title ?? "Pi agent board")}</h1>
<div class="sub">Generated ${esc(generatedAt)}${options.from || options.to ? ` · range ${esc(options.from ?? "")} → ${esc(options.to ?? "")}` : ""}</div>
<div class="metrics"><div class="metric"><b>${sorted.length}</b>sessions</div><div class="metric"><b>${fmtCost(totalCost)}</b>estimated cost</div><div class="metric"><b>${totalMessages}</b>messages</div><div class="metric"><b>${groups.length}</b>projects</div></div>
</header>
<section class="cards">${groupCards}</section>
<div class="wrap"><table><thead><tr><th>Status</th><th>Session</th><th>Project</th><th>Time</th><th>First prompt</th><th>Tools/files</th><th>Assistant signal</th><th>Msgs/cost</th></tr></thead><tbody>${rows}</tbody></table></div>
</body>
</html>`;
}
