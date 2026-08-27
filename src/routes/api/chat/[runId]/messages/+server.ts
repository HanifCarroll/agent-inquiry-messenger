import { sendToSession } from '$lib/server/sessions';
import { json } from '@sveltejs/kit';

export async function POST({ params, request, platform }) {
  // Store each message separately: KV is shared across isolates; the stream polls this prefix.
  const binding = (platform as any)?.env?.CHAT_MESSAGES;
  if (platform && !binding) return json({ error: 'Hosted human messages are not configured.' }, { status: 503 });
  let body: { message?: string };
  try { body = await request.json(); } catch { return json({ error: 'That message could not be read. Try again.' }, { status: 400 }); }
  const message = body.message?.trim();
  if (!message || message.length > 500) return json({ error: 'Write a message between 1 and 500 characters.' }, { status: 400 });
  if (platform) {
    await binding.put(`room:${params.runId}:${Date.now().toString().padStart(13, '0')}:${crypto.randomUUID()}`, message, { expirationTtl: 3600 });
  } else if (!sendToSession(params.runId, message)) return json({ error: 'This room is already closed.' }, { status: 404 });
  return json({ accepted: true }, { status: 202 });
}
