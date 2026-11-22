import { StatSection } from '../api/client.js';

export function sectionText(section?: StatSection): string | null {
  return section?.exitCode === 0 && section.output.trim() ? section.output.trim() : null;
}

export interface ProcessRow { pid: number; user: string; name: string; rss: number; vsz: number }

export function parseProcesses(section?: StatSection): ProcessRow[] | null {
  const text = sectionText(section);
  if (!text) return null;
  const [header, ...lines] = text.split('\n');
  if (header.trim().replace(/\s+/g, ' ') !== 'PID USER NAME RSS VSZ') return null;
  const rows: ProcessRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)$/);
    if (!match) return null;
    rows.push({ pid: Number(match[1]), user: match[2], name: match[3], rss: Number(match[4]), vsz: Number(match[5]) });
  }
  return rows;
}

export function parsePackage(section?: StatSection) {
  const text = sectionText(section);
  if (!text || !/Package \[/.test(text)) return null;
  const requested = new Set<string>();
  let inRequested = false;
  for (const line of text.split('\n')) {
    if (line.trim() === 'requested permissions:') { inRequested = true; continue; }
    if (inRequested) {
      const permission = line.trim().match(/^[\w.]+$/);
      if (permission) requested.add(permission[0]);
      else if (line.trim()) inRequested = false;
    }
  }
  const grants = [...text.matchAll(/[\w.]+:\s*granted=(true|false)/g)];
  return {
    requested: requested.size, granted: grants.filter(match => match[1] === 'true').length,
    denied: grants.filter(match => match[1] === 'false').length
  };
}

export function parseAppOps(section?: StatSection) {
  const text = sectionText(section);
  if (!text) return null;
  if (/^No operations\./.test(text)) return [];
  const rows = [...text.matchAll(/^\s*(?:Uid mode:\s*)?([A-Za-z0-9_]+):\s*(allow|ignore|deny|default|foreground|errored)\b/gmi)]
    .map(match => ({ operation: match[1], mode: match[2].toLowerCase() }));
  return rows.length ? rows : null;
}
