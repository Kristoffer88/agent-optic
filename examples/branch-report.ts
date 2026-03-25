#!/usr/bin/env bun
/**
 * branch-report.ts — Generate a self-contained HTML report of token usage and cost per branch.
 *
 * Usage:
 *   bun examples/branch-report.ts [path-to-.ai-usage.jsonl] > report.html
 *
 * Defaults to .ai-usage.jsonl in cwd if no argument is given.
 * Outputs a self-contained HTML file to stdout.
 */

import { basename, resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UsageRecord {
	commit: string;
	timestamp: string;
	branch: string;
	author: string;
	session_ids: string[];
	tokens: {
		input: number;
		output: number;
		cache_read: number;
		cache_write: number;
	};
	cost_usd: number;
	models: string[];
	messages: number;
	files_changed: number;
}

interface BranchStats {
	branch: string;
	costUsd: number;
	commits: number;
	filesChanged: number;
	messages: number;
	sessionIds: Set<string>;
	tokens: {
		input: number;
		output: number;
		cache_read: number;
		cache_write: number;
	};
	models: Set<string>;
	firstDate: string;
	lastDate: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return String(n);
}

function fmtCost(usd: number): string {
	if (usd >= 100) return `$${usd.toFixed(0)}`;
	if (usd >= 10) return `$${usd.toFixed(1)}`;
	return `$${usd.toFixed(2)}`;
}

function isoToDate(iso: string): string {
	return iso.slice(0, 10);
}

function costBarColor(cost: number, max: number): string {
	const ratio = max > 0 ? cost / max : 0;
	// green (0) → yellow (0.4) → orange (0.7) → red (1.0)
	if (ratio < 0.4) {
		const t = ratio / 0.4;
		const r = Math.round(50 + t * 205);
		const g = Math.round(180 - t * 40);
		return `rgb(${r},${g},60)`;
	}
	if (ratio < 0.7) {
		const t = (ratio - 0.4) / 0.3;
		const r = Math.round(255);
		const g = Math.round(140 - t * 60);
		return `rgb(${r},${g},30)`;
	}
	const t = (ratio - 0.7) / 0.3;
	const r = Math.round(255);
	const g = Math.round(80 - t * 60);
	return `rgb(${r},${g},20)`;
}

// ── Load and aggregate ────────────────────────────────────────────────────────

async function loadRecords(filePath: string): Promise<UsageRecord[]> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		process.stderr.write(`Error: file not found: ${filePath}\n`);
		process.exit(1);
	}
	const text = await file.text();
	const records: UsageRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as UsageRecord);
		} catch {
			// skip malformed lines
		}
	}
	return records;
}

function aggregateByBranch(records: UsageRecord[]): BranchStats[] {
	const map = new Map<string, BranchStats>();

	for (const r of records) {
		const branch = r.branch || "(unknown)";
		if (!map.has(branch)) {
			map.set(branch, {
				branch,
				costUsd: 0,
				commits: 0,
				filesChanged: 0,
				messages: 0,
				sessionIds: new Set(),
				tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
				models: new Set(),
				firstDate: isoToDate(r.timestamp),
				lastDate: isoToDate(r.timestamp),
			});
		}

		const s = map.get(branch)!;
		s.costUsd += r.cost_usd ?? 0;
		s.commits += 1;
		s.filesChanged += r.files_changed ?? 0;
		s.messages += r.messages ?? 0;
		for (const id of r.session_ids ?? []) s.sessionIds.add(id);
		s.tokens.input += r.tokens?.input ?? 0;
		s.tokens.output += r.tokens?.output ?? 0;
		s.tokens.cache_read += r.tokens?.cache_read ?? 0;
		s.tokens.cache_write += r.tokens?.cache_write ?? 0;
		for (const m of r.models ?? []) s.models.add(m);

		const d = isoToDate(r.timestamp);
		if (d < s.firstDate) s.firstDate = d;
		if (d > s.lastDate) s.lastDate = d;
	}

	return [...map.values()].sort((a, b) => b.costUsd - a.costUsd);
}

// ── HTML generation ───────────────────────────────────────────────────────────

function escHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function shortBranch(b: string): string {
	// Show last two path segments to keep it readable
	const parts = b.split("/");
	if (parts.length > 2) return parts.slice(-2).join("/");
	return b;
}

function buildHtml(branches: BranchStats[], projectTitle: string, records: UsageRecord[]): string {
	const totalCost = branches.reduce((s, b) => s + b.costUsd, 0);
	const totalTokens =
		branches.reduce((s, b) => s + b.tokens.input + b.tokens.output + b.tokens.cache_read + b.tokens.cache_write, 0);
	const totalCommits = branches.reduce((s, b) => s + b.commits, 0);
	const branchCount = branches.length;
	const maxCost = branches[0]?.costUsd ?? 1;

	const generatedAt = new Date().toLocaleString();

	// Build branch rows HTML
	const branchRows = branches.map((b) => {
		const barPct = maxCost > 0 ? (b.costUsd / maxCost) * 100 : 0;
		const barColor = costBarColor(b.costUsd, maxCost);
		const dateRange =
			b.firstDate === b.lastDate ? b.firstDate : `${b.firstDate} → ${b.lastDate}`;
		const totalTok = b.tokens.input + b.tokens.output + b.tokens.cache_read + b.tokens.cache_write;
		const modelList = [...b.models].join(", ");
		const modelLabel = modelList ? `<span class="tag">${escHtml(modelList)}</span>` : "";

		return `
    <div class="branch-row">
      <div class="branch-sidebar">
        <div class="branch-name" title="${escHtml(b.branch)}">${escHtml(shortBranch(b.branch))}</div>
        <div class="branch-full" title="${escHtml(b.branch)}">${escHtml(b.branch)}</div>
      </div>
      <div class="branch-content">
        <div class="branch-top">
          <div class="cost-area">
            <div class="cost-bar-wrap">
              <div class="cost-bar" style="width:${barPct.toFixed(1)}%;background:${barColor}"></div>
            </div>
            <span class="cost-label">${escHtml(fmtCost(b.costUsd))}</span>
          </div>
          <div class="branch-meta">
            <span class="meta-item" title="Commits"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="3"/><line x1="0" y1="8" x2="5" y2="8" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="1.5"/></svg> ${b.commits} commit${b.commits !== 1 ? "s" : ""}</span>
            <span class="meta-item" title="Files changed"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="1" width="9" height="14" rx="1"/><path d="M11 1l3 3v11"/><line x1="5" y1="6" x2="9" y2="6"/><line x1="5" y1="9" x2="9" y2="9"/></svg> ${b.filesChanged} file${b.filesChanged !== 1 ? "s" : ""}</span>
            <span class="meta-item" title="Messages"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H2a1 1 0 00-1 1v8a1 1 0 001 1h3l3 3 3-3h3a1 1 0 001-1V3a1 1 0 00-1-1z"/></svg> ${b.messages} msg</span>
            <span class="meta-item date">${escHtml(dateRange)}</span>
          </div>
        </div>
        <div class="token-row">
          <div class="token-block">
            <div class="token-value">${escHtml(fmtTokens(b.tokens.output))}</div>
            <div class="token-label">output</div>
          </div>
          <div class="token-block">
            <div class="token-value dim">${escHtml(fmtTokens(b.tokens.cache_read))}</div>
            <div class="token-label">cache read</div>
          </div>
          <div class="token-block">
            <div class="token-value dim">${escHtml(fmtTokens(b.tokens.cache_write))}</div>
            <div class="token-label">cache write</div>
          </div>
          <div class="token-block">
            <div class="token-value dim">${escHtml(fmtTokens(b.tokens.input))}</div>
            <div class="token-label">input</div>
          </div>
          <div class="token-block total">
            <div class="token-value">${escHtml(fmtTokens(totalTok))}</div>
            <div class="token-label">total tokens</div>
          </div>
          ${modelLabel ? `<div class="model-label">${modelLabel}</div>` : ""}
        </div>
      </div>
    </div>`;
	}).join("\n");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Branch AI Usage — ${escHtml(projectTitle)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #f7f8fa;
    --surface: #ffffff;
    --sidebar: #1e2230;
    --sidebar-text: #e8eaf0;
    --sidebar-sub: #8891aa;
    --border: #e2e5ec;
    --text: #1a1d2e;
    --text-sub: #6b7280;
    --accent: #4f6af0;
    --summary-bg: #1e2230;
    --summary-text: #e8eaf0;
    --bar-bg: #e8eaf0;
    --radius: 8px;
    --shadow: 0 1px 4px rgba(0,0,0,.08);
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }

  /* ── Header ── */
  .page-header {
    background: var(--summary-bg);
    color: var(--summary-text);
    padding: 28px 32px 24px;
  }
  .page-header h1 {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.3px;
    margin-bottom: 4px;
  }
  .page-header .subtitle {
    font-size: 13px;
    color: var(--sidebar-sub);
  }

  /* ── Summary bar ── */
  .summary-bar {
    display: flex;
    gap: 0;
    background: #161925;
    border-top: 1px solid #2d3248;
    padding: 0 32px;
    overflow-x: auto;
  }
  .summary-item {
    padding: 14px 28px 14px 0;
    margin-right: 28px;
    border-right: 1px solid #2d3248;
  }
  .summary-item:last-child { border-right: none; }
  .summary-value {
    font-size: 24px;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: -0.5px;
  }
  .summary-key {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--sidebar-sub);
    margin-top: 2px;
  }

  /* ── Main content ── */
  .main {
    max-width: 1100px;
    margin: 28px auto;
    padding: 0 20px;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: var(--text-sub);
    margin-bottom: 12px;
  }

  /* ── Branch rows ── */
  .branch-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .branch-row {
    display: flex;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .branch-sidebar {
    background: var(--sidebar);
    color: var(--sidebar-text);
    width: 200px;
    min-width: 160px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    word-break: break-all;
  }
  .branch-name {
    font-size: 13px;
    font-weight: 600;
    color: #ffffff;
    margin-bottom: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .branch-full {
    font-size: 10px;
    color: var(--sidebar-sub);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .branch-content {
    flex: 1;
    padding: 12px 18px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  /* ── Cost bar area ── */
  .branch-top {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .cost-area {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 180px;
  }
  .cost-bar-wrap {
    flex: 1;
    height: 10px;
    background: var(--bar-bg);
    border-radius: 5px;
    overflow: hidden;
  }
  .cost-bar {
    height: 100%;
    border-radius: 5px;
    transition: width 0.3s ease;
    min-width: 3px;
  }
  .cost-label {
    font-size: 16px;
    font-weight: 700;
    color: var(--text);
    min-width: 54px;
    text-align: right;
  }

  /* ── Meta row ── */
  .branch-meta {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    align-items: center;
  }
  .meta-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-sub);
    white-space: nowrap;
  }
  .meta-item.date { color: #9ba3b8; }
  .meta-item svg { flex-shrink: 0; opacity: 0.7; }

  /* ── Token row ── */
  .token-row {
    display: flex;
    gap: 18px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .token-block {
    display: flex;
    flex-direction: column;
    min-width: 52px;
  }
  .token-value {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .token-value.dim {
    color: var(--text-sub);
    font-weight: 500;
  }
  .token-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: #adb5c8;
    margin-top: 1px;
  }
  .token-block.total .token-value {
    color: var(--accent);
    font-weight: 700;
  }
  .model-label {
    margin-left: auto;
    align-self: flex-end;
  }
  .tag {
    display: inline-block;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 10px;
    background: #eef0f8;
    color: #5a6480;
    white-space: nowrap;
  }

  /* ── Footer ── */
  .footer {
    text-align: center;
    font-size: 11px;
    color: #adb5c8;
    padding: 28px 20px;
  }

  @media (max-width: 680px) {
    .page-header { padding: 20px 16px; }
    .summary-bar { padding: 0 16px; }
    .main { margin: 16px auto; padding: 0 10px; }
    .branch-sidebar { width: 130px; min-width: 100px; padding: 10px 12px; }
    .branch-content { padding: 10px 12px; }
    .cost-label { font-size: 14px; }
    .summary-value { font-size: 18px; }
  }
</style>
</head>
<body>

<div class="page-header">
  <h1>${escHtml(projectTitle)} — Branch AI Usage</h1>
  <div class="subtitle">Generated ${escHtml(generatedAt)} &middot; ${totalCommits} commits across ${branchCount} branch${branchCount !== 1 ? "es" : ""}</div>
</div>

<div class="summary-bar">
  <div class="summary-item">
    <div class="summary-value">${escHtml(fmtCost(totalCost))}</div>
    <div class="summary-key">Total cost</div>
  </div>
  <div class="summary-item">
    <div class="summary-value">${escHtml(fmtTokens(totalTokens))}</div>
    <div class="summary-key">Total tokens</div>
  </div>
  <div class="summary-item">
    <div class="summary-value">${totalCommits}</div>
    <div class="summary-key">Commits</div>
  </div>
  <div class="summary-item">
    <div class="summary-value">${branchCount}</div>
    <div class="summary-key">Branches</div>
  </div>
</div>

<div class="main">
  <div class="section-title">Branches by cost</div>
  <div class="branch-list">
${branchRows}
  </div>
</div>

<div class="footer">agent-optic &middot; ${escHtml(records.length.toString())} records read</div>

</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonlPath = resolve(args[0] ?? ".ai-usage.jsonl");

// Derive project title from path: parent directory name
const projectTitle = basename(jsonlPath) === ".ai-usage.jsonl"
	? basename(resolve(jsonlPath, ".."))
	: basename(jsonlPath).replace(/\.jsonl?$/, "");

const records = await loadRecords(jsonlPath);

if (records.length === 0) {
	process.stderr.write(`No records found in ${jsonlPath}\n`);
	process.exit(0);
}

const branches = aggregateByBranch(records);
const html = buildHtml(branches, projectTitle, records);

process.stdout.write(html + "\n");
