// resolve: record human resolution approvals (shared by the screen button and `guard resolve`). // [guard-serve:R4.3]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, decodeUtf8 } from './common.js';
import { atomicWriteJson, guardDir, localIso } from './config.js';
import { appendEvent } from './check.js';

export type Choice = 'revert-code' | 'edit-spec';
export interface ReportItem {
  id?: unknown;
  verdict?: unknown;
  reason?: unknown;
}
export interface Approved {
  requirement: string;
  choice: string;
  by: string;
  approvedAt: string;
}
export interface ResolutionDoc {
  approved: unknown[];
  closed?: unknown;
  [k: string]: unknown;
}

/** Thrown when approvals cannot be recorded; `status` is the HTTP status. */
export class ResolveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function isChoice(v: unknown): v is Choice {
  return v === 'revert-code' || v === 'edit-spec';
}

/** Red always; yellow `stale` only for edit-spec. // [guard-serve:R4.2][guard-serve:R5.1] */
export function canRecord(item: ReportItem, choice: Choice): boolean {
  if (item.verdict === 'red') return true;
  return item.verdict === 'yellow' && item.reason === 'stale' && choice === 'edit-spec';
}

/** Add approvals: older entries of the same requirement are dropped, new ones go last. // [guard-serve:R4.3] */
export function applyApproval(resolution: ResolutionDoc, targets: string[], choice: Choice, approvedAt: string): ResolutionDoc {
  const set = new Set(targets);
  const kept = resolution.approved.filter((a) => !(typeof a === 'object' && a !== null && set.has(String((a as { requirement?: unknown }).requirement))));
  const added: Approved[] = [...set].map((requirement) => ({ requirement, choice, by: 'human', approvedAt }));
  return { ...resolution, approved: [...kept, ...added] };
}

function readJson(file: string, missing: unknown): unknown {
  let text: string;
  try {
    text = decodeUtf8(readFileSync(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return missing;
    throw new ResolveError(`${file} is unreadable`, 409);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ResolveError(`${file} is unreadable`, 409);
  }
}

/** Requirement items of the current report. */
export function readReportItems(root: string): ReportItem[] {
  const rep = readJson(join(guardDir(root), 'report.json'), undefined);
  const list = (rep as { requirements?: unknown } | undefined)?.requirements;
  if (!Array.isArray(list)) throw new ResolveError('report.json is missing or has no requirements', 409);
  return list.filter((r): r is ReportItem => typeof r === 'object' && r !== null);
}

/** Ids of the red requirements. */
export function redIds(items: ReportItem[]): string[] {
  return items.filter((r) => r.verdict === 'red').map((r) => String(r.id));
}

/** Record approvals for targets (empty = every red one); returns the new resolution. // [guard-serve:R4.3][guard-serve:R5.2] */
export function recordResolution(rootDir: string, targets: string[] | undefined, choice: Choice, now: Date = new Date()): { resolution: ResolutionDoc; recorded: string[] } {
  const root = resolve(rootDir);
  const items = readReportItems(root);
  const ids = targets ?? redIds(items);
  if (ids.length === 0) throw new ResolveError('no violated requirements', 409);
  for (const id of ids) {
    const item = items.find((r) => String(r.id) === id);
    if (!item || !canRecord(item, choice)) throw new ResolveError(`${id} cannot be resolved with ${choice}`, 409);
  }
  const g = guardDir(root);
  const raw = readJson(join(g, 'resolution.json'), { approved: [] });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ResolveError('resolution.json is unreadable', 409);
  const doc = raw as Record<string, unknown>;
  const current: ResolutionDoc = { ...doc, approved: Array.isArray(doc.approved) ? doc.approved : [] };
  const next = applyApproval(current, ids, choice, localIso(now));
  atomicWriteJson(join(g, 'resolution.json'), next);
  const label = choice === 'revert-code' ? '코드를 되돌린다 승인' : '스펙을 고친다 승인';
  const recorded = [...new Set(ids)];
  for (const id of recorded) appendEvent(g, 'human', `${id} · ${label}`);
  return { resolution: next, recorded };
}

/** Resolve a command-line requirement word to full ids, or throw. // [guard-serve:R5.1] */
export function pickTargets(items: ReportItem[], word: string, choice: Choice): string[] {
  if (word === 'all') {
    const reds = redIds(items);
    if (reds.length === 0) throw new ResolveError('no violated requirements', 409);
    return reds;
  }
  const ok = items.filter((r) => canRecord(r, choice)).map((r) => String(r.id));
  if (ok.includes(word)) return [word];
  const short = ok.filter((id) => id.endsWith(':' + word));
  if (short.length === 1) return short;
  if (short.length > 1) throw new ResolveError(`${word} is ambiguous: ${short.join(', ')}`, 409);
  throw new ResolveError(`${word} cannot be resolved with ${choice}`, 409);
}

/** `guard resolve <requirement|all> <revert-code|edit-spec> [--root]`. // [guard-serve:R5.1] */
export function resolveCommand(o: { positionals: string[]; root?: string; cwd: string }): { code: number; stdout: string; stderr: string } {
  const [word, choice] = o.positionals;
  if (o.positionals.length !== 2 || !isChoice(choice)) throw new UsageError('resolve needs <requirement|all> <revert-code|edit-spec>');
  const root = resolve(o.cwd, o.root ?? '.');
  try {
    const targets = pickTargets(readReportItems(root), word, choice);
    const r = recordResolution(root, targets, choice);
    return { code: 0, stdout: r.recorded.map((id) => id + '\n').join(''), stderr: '' };
  } catch (e) {
    if (e instanceof ResolveError) return { code: 1, stdout: '', stderr: `guard resolve: ${e.message}\n` };
    throw e;
  }
}