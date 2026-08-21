import { catalog, run, type ChatEvent, type DecisionMode, type Model } from '$lib/server/protocol';
import { registerSession } from '$lib/server/sessions';
import { saveRun } from '$lib/server/storage';
import { validScreenNames } from '$lib/identity';
import { json } from '@sveltejs/kit';

export async function POST({ request }) {
  let body: { question?: string; models?: string[]; screenNames?: string[]; participantCount?: number; debateTurns?: number; research?: boolean; mode?: DecisionMode };
  try { body = await request.json(); } catch { return json({ error: 'The room setup could not be read. Try again.' }, { status: 400 }); }
  const question = body.question?.trim();
  const ids = body.models ?? [];
  const aliases = body.screenNames;
  const participantCount = body.participantCount ?? ids.length;
  const debateTurns = body.debateTurns ?? 6;
  const research = body.research ?? false;
  const mode = body.mode ?? 'consensus';
  if (!Number.isInteger(participantCount) || participantCount < 2 || participantCount > 5) return json({ error: 'Choose 2 to 5 agents.' }, { status: 400 });
  if (!question || ids.length !== participantCount) return json({ error: `Choose ${participantCount} agents and enter a question.` }, { status: 400 });
  if (!validScreenNames(aliases, participantCount)) return json({ error: 'The agent names could not be set. Start a new room and try again.' }, { status: 400 });
  if (!Number.isInteger(debateTurns) || debateTurns < 1 || debateTurns > 12) return json({ error: 'Choose 1 to 12 chat rounds.' }, { status: 400 });
  if (typeof research !== 'boolean') return json({ error: 'The web search setting was not recognized.' }, { status: 400 });
  if (mode !== 'consensus' && mode !== 'vote') return json({ error: 'Choose how the room should finish.' }, { status: 400 });
  try {
    const available = await catalog();
    const selected = ids.map(id => available.find(model => model.id === id)).filter(Boolean) as Model[];
    if (selected.length !== ids.length) return json({ error: 'One of your agents is no longer available. Choose another and try again.' }, { status: 400 });
    const events: ChatEvent[] = [];
    const conversation: ChatEvent[] = [];
    const runId = crypto.randomUUID();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: ChatEvent) => {
          const outgoing = event.type === 'run' ? { ...event, run_id: runId } : event;
          events.push(outgoing); controller.enqueue(`${JSON.stringify(outgoing)}\n`);
        };
        const unregister = registerSession(runId, message => {
          const event = { type: 'message', phase: 'human', participant: 'human', model: 'You', message, sources: [], created_at: new Date().toISOString() };
          conversation.push(event); emit(event);
        });
        try { await run(question, selected, debateTurns, research, mode, emit, conversation, aliases); }
        catch (error) { emit({ type: 'error', error: error instanceof Error ? error.message : 'The room stopped unexpectedly.', calls: events.filter(event => event.type === 'message' && event.participant !== 'human').length }); }
        finally { unregister(); try { emit({ type: 'saved', filename: await saveRun(events) }); } catch (error) { emit({ type: 'error', error: error instanceof Error ? error.message : 'Could not save run' }); } controller.close(); }
      }
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'OpenRouter could not be reached. Try again.' }, { status: 502 }); }
}
