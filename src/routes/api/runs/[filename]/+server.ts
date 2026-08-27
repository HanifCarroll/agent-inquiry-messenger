import { error, json } from '@sveltejs/kit';
import { readRun } from '$lib/server/storage';
export async function GET({ params, platform }) {
  if (platform) throw error(404, 'Saved transcripts are not available in hosted mode.');
  try { return json({ events: await readRun(params.filename) }); }
  catch (reason) { throw error(404, reason instanceof Error ? reason.message : 'Run not found'); }
}
