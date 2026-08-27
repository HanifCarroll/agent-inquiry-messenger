import { catalog, key, requestApiKey, run, selectedModelsAllowed, USER_KEY_HEADER, type ChatEvent, type DecisionMode, type Model } from '$lib/server/protocol';
import { registerSession } from '$lib/server/sessions';
import { saveRun } from '$lib/server/storage';
import { validPersonalityIds, validScreenNames, type PersonalityId } from '$lib/identity';
import { json } from '@sveltejs/kit';

export async function POST({ request, platform, getClientAddress }) {
  const userKey = request.headers.get(USER_KEY_HEADER)?.trim();
  const env = (platform as any)?.env;
  const { apiKey: participantApiKey, guest } = requestApiKey(userKey, env);
  const interpreterApiKey = key(env);
  if (userKey && (userKey.length > 512 || !userKey.startsWith('sk-or-'))) return json({ error: 'That OpenRouter connection is invalid.' }, { status: 400 });
  let body: { question?: string; models?: string[]; screenNames?: string[]; personalityIds?: PersonalityId[]; participantCount?: number; debateTurns?: number; research?: boolean; mode?: DecisionMode };
  try { body = await request.json(); } catch { return json({ error: 'The room setup could not be read. Try again.' }, { status: 400 }); }
  const question = body.question?.trim();
  const ids = body.models ?? [];
  const aliases = body.screenNames;
  const personalityIds = body.personalityIds;
  const participantCount = body.participantCount ?? ids.length;
  const debateTurns = body.debateTurns ?? 3;
  const research = body.research ?? false;
  const mode = body.mode ?? 'consensus';
  if (!Number.isInteger(participantCount) || participantCount < 2 || participantCount > 5) return json({ error: 'Choose 2 to 5 agents.' }, { status: 400 });
  if (!question || ids.length !== participantCount) return json({ error: `Choose ${participantCount} agents and enter a question.` }, { status: 400 });
  if (!validScreenNames(aliases, participantCount)) return json({ error: 'The agent names could not be set. Start a new room and try again.' }, { status: 400 });
  if (!validPersonalityIds(personalityIds, participantCount)) return json({ error: 'The agent personalities could not be set. Start a new room and try again.' }, { status: 400 });
  if (!Number.isInteger(debateTurns) || debateTurns < 1 || debateTurns > 12) return json({ error: 'Choose 1 to 12 chat rounds.' }, { status: 400 });
  if (typeof research !== 'boolean') return json({ error: 'The web search setting was not recognized.' }, { status: 400 });
  if (mode !== 'consensus' && mode !== 'vote') return json({ error: 'Choose how the room should finish.' }, { status: 400 });
  try {
    if (!selectedModelsAllowed(ids, guest)) return json({ error: 'Guests can only use free participant models. Connect OpenRouter to use paid models.' }, { status: 403 });
    const available = await catalog(participantApiKey, guest);
    const selected = ids.map(id => available.find(model => model.id === id)).filter(Boolean) as Model[];
    if (selected.length !== ids.length) return json({ error: 'One of your agents is no longer available. Choose another and try again.' }, { status: 400 });
    const limiter = env?.GUEST_LIMITER;
    if (platform && limiter) {
      const result = await limiter.limit({ key: getClientAddress() });
      if (!result.success) return json({ error: 'Room starts are temporarily limited. Try again in a minute.' }, { status: 429 });
    }
    const events: ChatEvent[] = [];
    const conversation: ChatEvent[] = [];
    const runId = crypto.randomUUID();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: ChatEvent) => {
          const outgoing = event.type === 'run' ? { ...event, run_id: runId } : event;
          events.push(outgoing); controller.enqueue(`${JSON.stringify(outgoing)}\n`);
        };
        const messagesBinding = env?.CHAT_MESSAGES;
        const seen = new Set<string>();
        const addHuman = (message: string) => { const event = { type: 'message', phase: 'human', participant: 'human', model: 'You', message, sources: [], created_at: new Date().toISOString() }; conversation.push(event); emit(event); };
        const unregister = platform ? () => {} : registerSession(runId, addHuman);
        const pollHuman = async () => {
          if (!messagesBinding) return;
          const listed = await messagesBinding.list({ prefix: `room:${runId}:` });
          for (const item of listed.keys) if (!seen.has(item.name)) { const message = await messagesBinding.get(item.name); if (message) { seen.add(item.name); addHuman(message); } }
        };
        try { await run(participantApiKey, interpreterApiKey, question, selected, debateTurns, research, mode, emit, conversation, aliases, personalityIds, pollHuman); }
        catch (error) { emit({ type: 'error', error: error instanceof Error ? error.message : 'The room stopped unexpectedly.', calls: events.filter(event => event.type === 'message' && event.participant !== 'human').length }); }
        finally { unregister(); if (!platform) { try { emit({ type: 'saved', filename: await saveRun(events) }); } catch (error) { emit({ type: 'error', error: error instanceof Error ? error.message : 'Could not save run' }); } } controller.close(); }
      }
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'OpenRouter could not be reached. Try again.' }, { status: 502 }); }
}
