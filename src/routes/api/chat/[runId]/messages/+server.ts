import { sendToSession } from '$lib/server/sessions';
import { json } from '@sveltejs/kit';

export async function POST({ params, request }) {
  let body: { message?: string };
  try { body = await request.json(); } catch { return json({ error: 'That message could not be read. Try again.' }, { status: 400 }); }
  const message = body.message?.trim();
  if (!message || message.length > 500) return json({ error: 'Write a message between 1 and 500 characters.' }, { status: 400 });
  if (!sendToSession(params.runId, message)) return json({ error: 'This room is already closed.' }, { status: 404 });
  return json({ accepted: true }, { status: 202 });
}
