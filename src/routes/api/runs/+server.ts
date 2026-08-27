import { json } from '@sveltejs/kit';
import { listRuns } from '$lib/server/storage';
export async function GET({ platform }) { return json({ runs: platform ? [] : await listRuns() }); }
