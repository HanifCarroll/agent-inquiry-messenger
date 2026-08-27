export const RUNS_DIR = 'runs/';
export const RUN_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;
export type RunEvent = Record<string, any>;

export function validRunFilename(filename: string) {
  return RUN_FILENAME.test(filename) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}
export function parseJsonl(text: string): RunEvent[] {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at line ${index + 1}`); }
  });
}

export async function saveRun(events: RunEvent[]) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const filename = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}.jsonl`;
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(`${RUNS_DIR}${filename}`, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  return filename;
}
export async function readRun(filename: string) {
  if (!validRunFilename(filename)) throw new Error('Invalid run filename');
  const { access, readFile } = await import('node:fs/promises');
  const path = `${RUNS_DIR}${filename}`;
  try { await access(path); } catch { throw new Error('Run not found'); }
  return parseJsonl(await readFile(path, 'utf8'));
}
export async function listRuns() {
  const { readdir } = await import('node:fs/promises');
  let names: string[];
  try { names = await readdir(RUNS_DIR); } catch { return []; }
  return names.filter(name => name.endsWith('.jsonl') && validRunFilename(name)).sort().reverse();
}
