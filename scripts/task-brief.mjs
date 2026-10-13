#!/usr/bin/env node
// Prints ONLY what Claude needs for one backlog task: the task block, its
// dependency states, the recommended model, and just the PLAN.md / PATTERNS.md
// parts its "Ref" line cites. Replaces reading PLAN.md and the backlogs whole.
//
// Usage:  node scripts/task-brief.mjs S1-05
//         node scripts/task-brief.mjs            (uses the task under "Now" in STATUS.md)
//         node scripts/task-brief.mjs --next     (first TODO task whose deps are DONE)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n') : '');

const PLAN = read('PLAN.md');
const PATTERNS = read('docs/build/PATTERNS.md');
const STATUS = read('docs/build/STATUS.md');
const BACKLOGS = ['docs/build/BACKLOG-R1.md', 'docs/build/BACKLOG-R2-R4.md'];
const MAX_SECTION_LINES = 70;
// Matches S1-06, S1-06a, follow-ups S1-F6 and S1-06-F1, and R2-03.
const ID = String.raw`(?:S\d+|R\d)-F?\d+(?:-F\d+)?[a-z]?`;
const TASK_ID = new RegExp(String.raw`\b(${ID})\b`);

// ---------- task lookup ----------
function allTasks() {
  const tasks = [];
  for (const file of BACKLOGS) {
    const lines = read(file).split('\n');
    let cur = null;
    for (const line of lines) {
      const h = line.match(new RegExp(`^### (${ID}) · (.*)$`));
      if (h) {
        cur = { id: h[1], title: h[2], file, lines: [line] };
        tasks.push(cur);
      } else if (cur) {
        if (/^## /.test(line) || /^---\s*$/.test(line)) cur = null;
        else cur.lines.push(line);
      }
    }
  }
  for (const t of tasks) t.text = t.lines.join('\n').trimEnd();
  return tasks;
}

function statusOf(id) {
  const m = STATUS.match(new RegExp(`^\\|\\s*${id}\\s*\\|\\s*([^|]*?)\\s*\\|`, 'm'));
  return m ? m[1] || 'TODO' : 'not in STATUS';
}

function depsOf(task) {
  const m = task.text.match(/· Dep ([^·\n]*)/);
  return m ? m[1].match(new RegExp(ID, 'g')) || [] : [];
}

function pickTask(tasks, arg) {
  if (arg && arg !== '--next') return tasks.find((t) => t.id === arg);
  if (!arg) {
    const now = STATUS.split('## Now')[1]?.split('\n## ')[0] || '';
    const id = now.match(TASK_ID)?.[1];
    if (id) return tasks.find((t) => t.id === id);
  }
  return tasks.find((t) => statusOf(t.id).startsWith('TODO') && depsOf(t).every((d) => statusOf(d).startsWith('DONE')));
}

// ---------- PLAN.md extraction ----------
const planLines = PLAN.split('\n');

function sectionRange(num) {
  const start = planLines.findIndex((l) => l.startsWith(`## ${num}. `));
  if (start < 0) return null;
  let end = planLines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = planLines.length;
  return [start, end];
}

function subsectionRange(num) {
  const start = planLines.findIndex((l) => l.startsWith(`### ${num} `));
  if (start < 0) return null;
  let end = planLines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  if (end < 0) end = planLines.length;
  return [start, end];
}

function slice([a, b], cap = MAX_SECTION_LINES) {
  const body = planLines.slice(a, b);
  const text = body.slice(0, cap).join('\n').trimEnd();
  return body.length > cap ? `${text}\n… (truncated: PLAN.md lines ${a + 1}-${b}; read more only if needed)` : text;
}

function tableRows(sectionNum, nums) {
  const r = sectionRange(sectionNum);
  if (!r) return '';
  const lines = planLines.slice(r[0], r[1]);
  const header = lines.filter((l) => l.startsWith('|')).slice(0, 2);
  const rows = nums.map((n) => lines.find((l) => l.startsWith(`| ${n} |`))).filter(Boolean);
  return [planLines[r[0]], ...header, ...rows].join('\n');
}

function moduleBlocks(mods) {
  return mods
    .map((m) => {
      const start = planLines.findIndex((l) => l.startsWith(`### ${m} · `));
      if (start < 0) return '';
      let end = planLines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
      if (end < 0) end = planLines.length;
      return slice([start, end]);
    })
    .filter(Boolean)
    .join('\n\n');
}

function domainBlock(words) {
  const r = sectionRange(6);
  if (!r) return '';
  const key = words.toLowerCase().split(/[\s/]+/)[0];
  const start = planLines.findIndex(
    (l, i) => i > r[0] && i < r[1] && l.startsWith('**') && l.toLowerCase().includes(key),
  );
  if (start < 0) return '';
  let end = planLines.findIndex((l, i) => i > start && (l.startsWith('**') || /^#{2,3} /.test(l)));
  if (end < 0) end = r[1];
  return `## 6. DOMAIN MODEL (excerpt)\n${slice([start, end])}`;
}

function releaseBlock(rel) {
  const start = planLines.findIndex((l) => l.startsWith(`### ${rel} `));
  if (start < 0) return '';
  let end = planLines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  if (end < 0) end = planLines.length;
  return slice([start, end]);
}

function patternsSection(num) {
  const lines = PATTERNS.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## §${num} `));
  if (start < 0) return '';
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return `(PATTERNS.md)\n${lines.slice(start, end).join('\n').trimEnd()}`;
}

function extractRefs(task) {
  const refLine = task.text.match(/^Ref (.*?)(?: · Mod|$)/m)?.[1] || '';
  const parts = refLine
    .split(/(?=(?:PATTERNS )?§)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^(PATTERNS )?§(\d+)(?:\.(\d+))?\s*(.*)$/);
    if (!m) continue;
    const [, isPatterns, major, minor, rest] = m;
    const nums = (rest.match(/#(\d+)/g) || []).map((s) => s.slice(1));
    const mods = rest.match(/\bM\d+\b/g) || [];
    const rels = rest.match(/\bR\d\b/g) || [];
    const words = rest.replace(/\(.*?\)|#\d+|\bM\d+\b|\bR\d\b/g, '').trim();
    let block = '';
    if (isPatterns) block = patternsSection(major);
    else if (minor) block = slice(subsectionRange(`${major}.${minor}`) || [0, 0]);
    else if ((major === '3' || major === '8') && nums.length) block = tableRows(major, nums);
    else if (major === '3') block = '';
    else if (major === '7' && mods.length) block = moduleBlocks(mods);
    else if (major === '6' && words) block = domainBlock(words);
    else if (major === '16' && rels.length) block = rels.map(releaseBlock).join('\n\n');
    else {
      const r = sectionRange(major);
      block = r ? slice(r) : '';
    }
    if (block) out.push({ ref: part, block });
  }
  return out;
}

// ---------- main ----------
const arg = process.argv[2];
const tasks = allTasks();
const task = pickTask(tasks, arg);

if (!task) {
  console.log(
    arg
      ? `Task ${arg} not found in the backlogs.`
      : 'No ready task found (all TODO tasks have unfinished dependencies).',
  );
  process.exit(1);
}

const hard = /⚡|🔒/.test(task.text.split('\n')[1] || '') || /^S0-/.test(task.id);
const deps = depsOf(task);

console.log(`# Task brief: ${task.id}`);
console.log(`Source: ${task.file}`);
console.log(`Recommended model: ${hard ? 'OPUS (hot-path, security or foundation task)' : 'SONNET (routine task)'}`);
console.log(`Status: ${statusOf(task.id)}`);
if (deps.length) console.log(`Dependencies: ${deps.map((d) => `${d}=${statusOf(d)}`).join(', ')}`);
console.log(`\n${task.text}\n`);

const refs = extractRefs(task);
if (refs.length) {
  console.log('---\n# Cited PLAN.md / PATTERNS.md excerpts\n');
  const seen = new Set();
  for (const { ref, block } of refs) {
    if (seen.has(block)) continue;
    seen.add(block);
    console.log(`<!-- ref: ${ref} -->\n${block}\n`);
  }
}
