import { json } from '@sveltejs/kit';
import { listRuns } from '$lib/server/storage';
export async function GET() { return json({ runs: await listRuns() }); }
