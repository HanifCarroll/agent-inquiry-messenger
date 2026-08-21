import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { OpenRouter } from '@openrouter/sdk';
import type { ChatRequest, ChatRequestEffort, ChatResult, Model as SDKModel } from '@openrouter/sdk/models';
import { screenNames, validScreenNames } from '../identity';

export type Model = SDKModel;
export type DecisionMode = 'consensus' | 'vote';
export type Decision = { participant: number; type: 'propose' | 'support' | 'undecided'; proposal: string };
export type ChatEvent = Record<string, any>;
export const INTERPRETER_MODEL = 'openai/gpt-5.6-luna';

export function formatProposalList(proposals: Iterable<string>): string {
  const texts = [...proposals];
  return texts.length ? texts.map(text => `- ${text}`).join('\n') : '(none)';
}

export function key(): string {
  const env = process.env.OPENROUTER_API_KEY;
  if (env) return env;
  const result = spawnSync('security', ['find-generic-password', '-s', 'agent-chatroom-openrouter', '-a', process.env.USER ?? 'agent-chatroom', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const value = result.stdout.trim();
  if (!value) throw new Error('OpenRouter is not connected. Add your API key and try again.');
  return value;
}

export function proposalId(proposal: string): string { return createHash('sha256').update(proposal).digest('hex').slice(0, 12); }
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export function requestErrorText(error: unknown): string {
  const upstream = (error as any)?.error?.metadata?.raw;
  return nonempty(upstream) ? upstream : error instanceof Error ? error.message : 'request failed';
}

const RETRY_BUFFER_MS = 250;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function rateLimitWaitMs(error: unknown, now = Date.now()): number | null {
  const value = error as any;
  if (value?.statusCode !== 429 && !/(?:rate[ -]?limit|too many requests)/i.test(requestErrorText(error))) return null;
  const header = (name: string) => value?.headers?.get?.(name) ?? value?.headers?.[name] ?? value?.headers?.[name.toLowerCase()];
  const retryAfterMs = Number(header('retry-after-ms'));
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs + RETRY_BUFFER_MS;
  const retryAfter = header('retry-after');
  if (nonempty(retryAfter)) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000 + RETRY_BUFFER_MS;
    const resetAt = Date.parse(retryAfter);
    if (Number.isFinite(resetAt)) return Math.max(0, resetAt - now) + RETRY_BUFFER_MS;
  }
  return 60_000 + RETRY_BUFFER_MS;
}

export function responseDelayMs(message: string, random = Math.random()): number {
  const wordDelay = Math.min((message.match(/\S+/g)?.length ?? 0) * 75, 1500);
  return 2500 + wordDelay + Math.floor(random * 1800);
}

export class InterpreterError extends Error {
  constructor(message: string, public usage: Record<string, any> = { cost: 0 }) { super(`Luna could not read the room: ${message}`); }
}

let client: OpenRouter | undefined;
function openRouter() {
  return client ??= new OpenRouter({ apiKey: key(), httpReferer: 'https://github.com/HanifCarroll/agent-inquiry-messenger', appTitle: 'Agent Inquiry Messenger', retryConfig: { strategy: 'backoff', backoff: { initialInterval: 500, maxInterval: 3000, exponent: 2, maxElapsedTime: 10000 }, retryConnectionErrors: true } });
}

const interpreterSchema = {
  type: 'object', additionalProperties: false,
  properties: { decisions: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, properties: {
    participant: { type: 'integer', minimum: 0 },
    type: { type: 'string', enum: ['propose', 'support', 'undecided'] },
    proposal: { type: 'string', maxLength: 500 }
  }, required: ['participant', 'type', 'proposal'] } } },
  required: ['decisions']
};
const LUNA_SYSTEM = `You are Luna, a neutral transcript clerk. Read the ordinary group chat and report each participant's latest main position. Never assess answer quality, choose an answer, or count the human. Resolve conversational references such as "that one," "you sold me," or "still going with mine" only when the transcript makes the referent clear; otherwise mark the participant undecided. A caveat or exception does not replace someone's main position unless they actually switch their answer. For support, return the exact matching registered proposal text. For propose, extract a concise complete answer actually advanced by that participant. Return an object with a decisions array containing exactly one decision for every participant.`;

export function participantReasoning(model: Pick<Model, 'reasoning'>): ChatRequestEffort {
  if (!model.reasoning?.mandatory) return 'none';
  return model.reasoning.supportedEfforts?.filter(effort => effort && effort !== 'none').at(-1) ?? 'minimal';
}

async function request(model: string, messages: ChatRequest['messages'], plugin = false, structured = false, reasoning: ChatRequestEffort = 'none', onRateLimit?: (waitMs: number) => void) {
  const chatRequest: any = { model, messages, maxTokens: structured ? 1200 : 100, stream: false, ...(plugin ? { plugins: [{ id: 'web', engine: 'exa', maxResults: 5 }] } : {}) };
  if (!structured) chatRequest.reasoning = { effort: reasoning };
  if (structured) {
    chatRequest.responseFormat = { type: 'json_schema', jsonSchema: { name: 'luna_decisions', strict: true, schema: interpreterSchema } };
    chatRequest.provider = { requireParameters: true };
  }
  let response;
  for (;;) {
    try { response = await openRouter().chat.send({ chatRequest }, { retryCodes: ['5XX'] }); break; }
    catch (error) {
      const waitMs = rateLimitWaitMs(error);
      if (waitMs === null) throw error;
      onRateLimit?.(waitMs);
      await sleep(waitMs);
    }
  }
  const result = response as ChatResult;
  const content = result.choices?.[0]?.message?.content;
  return { content: typeof content === 'string' ? content : '', usage: result.usage ?? { cost: 0 } };
}

export const CHAT_VOICES = [
  'You are terse and usually send a fragment rather than a polished sentence.',
  'You are upbeat and occasionally use lol, haha, or an old-school text face like :) when it genuinely fits.',
  'You are skeptical and direct, but friendly. You often ask a short question or point out one weak spot.',
  'You type casually and sometimes leave in a harmless typo or missing apostrophe.',
  'You are dry and understated. You rarely use slang and never sound like a judge or lecturer.',
  'You are excitable and sometimes emphasize one word with ALL CAPS or repeated punctuation.'
] as const;

export const SYSTEM_PROMPT = `You are a person chatting with a few other agents about the user's question. Have a real opinion, pay attention to what everyone has said, and try to convince them when you disagree. Change your mind only when something in the chat actually persuades you.

Write the next thing you would actually type in an AIM group chat. React to one point instead of recapping the room. It is fine to joke, ask a quick question, hesitate, disagree, or say someone changed your mind. Do not use formal debate language such as "I support," "my proposal," "the stronger case," "listed options," or "final ballot."

Keep it very short: one or two message-sized lines, no more than 35 words total. Most replies should be much shorter. Use early-2000s AIM habits lightly: lowercase, loose punctuation, and an occasional imo, idk, bc, u, tho, lol, haha, brb, or text face when it fits. Do not stuff every reply with slang. Avoid modern emojis and current internet slang.

Return plain text only. Never use Markdown, JSON, labels, decision metadata, or your own screen name as a prefix. Cite only sources you actually used.`;
export function openingPrompt(question: string, transcript: string, research: boolean) { return `Room question:\n${question}\n\nChat so far:\n${transcript || '(nobody has said anything yet)'}\n\nRead the whole chat before typing. ${research ? 'Look up what you need first.' : 'Use what you know.'} Give your honest first reaction or answer. If someone already spoke, respond to what they actually said.`; }
export function debatePrompt(question: string, transcript: string) { return `Room question:\n${question}\n\nChat so far:\n${transcript}\n\nRead everything above, including the newest message, then type the next natural reply. Push back, add one useful thought, ask something, or admit if somebody changed your mind. Do not summarize the room.`; }
export function ballotPrompt(question: string, transcript: string, proposalList: string) { return `Room question:\n${question}\n\nChat so far:\n${transcript}\n\nAnswers people have mentioned:\n${proposalList}\n\nRead everything above. Send one last normal chat message saying what you are going with. Do not call it a vote, ballot, proposal, or support.`; }

function parseJson(text: string): unknown { return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); }
export function validateInterpretation(value: unknown, participantCount: number, registered: Map<string, string> | Set<string>): Decision[] {
  const raw = value && typeof value === 'object' && 'decisions' in value ? (value as any).decisions : null;
  if (!Array.isArray(raw) || raw.length !== participantCount) throw new InterpreterError('the room state was incomplete');
  const decisions = raw.map((item: any) => ({ participant: item?.participant, type: item?.type, proposal: item?.proposal }));
  const ids = new Set<number>();
  for (const d of decisions) {
    if (!Number.isInteger(d.participant) || d.participant < 0 || d.participant >= participantCount || ids.has(d.participant)) throw new InterpreterError('one or more agent positions were missing');
    ids.add(d.participant);
    if (!['propose', 'support', 'undecided'].includes(d.type) || typeof d.proposal !== 'string') throw new InterpreterError('one or more agent positions were unclear');
  }
  const available = new Map<string, string>();
  if (registered instanceof Map) for (const [id, text] of registered) available.set(id, text);
  for (const d of decisions.filter(d => d.type === 'propose' && nonempty(d.proposal))) available.set(proposalId(d.proposal), d.proposal);
  return decisions.map(d => {
    if (d.type === 'undecided' || (d.type === 'propose' && !nonempty(d.proposal))) return { ...d, type: 'undecided' as const, proposal: '' };
    if (d.type === 'support' && available.get(proposalId(d.proposal)) !== d.proposal) return { ...d, type: 'undecided' as const, proposal: '' };
    return d;
  });
}

export function applyInterpretation(value: unknown, participantCount: number, registered: Map<string, string>): Decision[] {
  const decisions = validateInterpretation(value, participantCount, registered);
  for (const d of decisions) if (d.type === 'propose') registered.set(proposalId(d.proposal), d.proposal);
  return decisions;
}

export async function askParticipant(model: Model, screenName: string, voice: string, prompt: string, research: boolean, onRateLimit?: (waitMs: number) => void) {
  let result;
  try { result = await request(model.id, [{ role: 'system', content: `${SYSTEM_PROMPT}\n\nYour screen name is ${screenName}, but do not type it in your messages. ${voice}` }, { role: 'user', content: prompt }], research, false, participantReasoning(model), onRateLimit); }
  catch (error) { throw new Error(`${screenName} could not reply: ${requestErrorText(error)}`); }
  if (!result.content.trim()) throw new Error(`Empty response from ${screenName}`);
  return { message: result.content.trim(), usage: result.usage };
}

export async function interpret(question: string, participantCount: number, registered: Map<string, string>, transcriptMessages: ChatEvent[], names: string[], onRateLimit?: (waitMs: number) => void) {
  const proposals = formatProposalList([...registered.values()]);
  const transcript = transcriptMessages.map(message => `${message.participant === 'human' ? 'Human (not a participant)' : `Participant ${message.participant} (${names[message.participant]})`}: ${message.message}`).join('\n');
  const result = await request(INTERPRETER_MODEL, [{ role: 'system', content: LUNA_SYSTEM }, { role: 'user', content: `Question:\n${question}\n\nRegistered proposals (exact text):\n${proposals}\n\nFull chat in chronological order:\n${transcript}\n\nReport every participant's latest current position now.` }], false, true, 'none', onRateLimit);
  let parsed: unknown;
  try { parsed = parseJson(result.content); } catch { throw new InterpreterError('the latest positions were unclear', result.usage); }
  try { return { decisions: applyInterpretation(parsed, participantCount, registered), usage: result.usage }; } catch (error) { if (error instanceof InterpreterError) error.usage = result.usage; throw error; }
}

export function chatCapable(model: Pick<Model, 'architecture'>) {
  const input = model.architecture?.inputModalities ?? [];
  const output = model.architecture?.outputModalities ?? [];
  return input.includes('text') && output.length === 1 && output[0] === 'text';
}
export async function catalog(): Promise<Model[]> { const pages = await openRouter().models.list(); const models: Model[] = []; for await (const page of pages) models.push(...page.result.data); return models.filter(model => chatCapable(model) && !model.id.endsWith(':batch')); }
export function price(model: Model) { const perMillion = (value: string) => { const amount = Number(value) * 1_000_000; return Number.isFinite(amount) && amount >= 0 ? amount : null; }; return { input: perMillion(model.pricing.prompt), output: perMillion(model.pricing.completion) }; }

export function latestSupportUnanimous(decisions: Decision[] | ChatEvent[], participantCount: number): string | null {
  const latest: any[] = Array.from({ length: participantCount });
  for (const item of decisions) if (Number.isInteger(item.participant) && item.participant >= 0 && item.participant < participantCount) latest[item.participant] = item;
  if (latest.some(item => item?.type !== 'support')) return null;
  const proposals = latest.map(item => item.proposal);
  return proposals.every(proposal => proposal === proposals[0]) ? proposals[0] : null;
}
export function voteWinner(decisions: Decision[], registered: Set<string>): { proposal: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const decision of decisions) if (decision.type === 'support' && registered.has(proposalId(decision.proposal))) counts.set(decision.proposal, (counts.get(decision.proposal) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? { proposal: ranked[0][0], count: ranked[0][1] } : null;
}

export function outcomeText(final: ChatEvent, participantCount: number): string {
  if (final.status === 'CONSENSUS') return `Everyone agreed: ${final.proposal}`;
  if (final.status === 'VOTE') return `${final.proposal} won with ${final.vote_count} of ${participantCount} votes.`;
  if (final.status === 'TIE') return 'the vote ended in a tie.';
  if (final.status === 'NO_WINNER') return 'the vote ended without a clear choice.';
  if (final.status === 'NO_CONSENSUS') return 'the room ended without settling on one answer.';
  return 'the room stopped before reaching an outcome.';
}

export async function run(question: string, models: Model[], debateTurns: number, research: boolean, mode: DecisionMode, emit: (event: ChatEvent) => void, messages: ChatEvent[] = [], aliases?: string[]) {
  const registered = new Map<string, string>(); const started = new Date().toISOString(); const names = validScreenNames(aliases, models.length) ? aliases : screenNames(models.length);
  const maxCalls = (models.length + 1) * (1 + debateTurns + (mode === 'vote' ? 1 : 0)); let cost = 0; let calls = 0;
  emit({ type: 'run', question, models: models.map(m => m.id), screen_names: names, interpreter: INTERPRETER_MODEL, debate_turns: debateTurns, research, mode, started_at: started, max_calls: maxCalls });
  const waitMessage = (waitMs: number) => `got rate-limited — retrying in ${Math.ceil(waitMs / 1000)}s…`;
  const pace = async (startedAt: number, message: string) => { const remaining = responseDelayMs(message) - (Date.now() - startedAt); if (remaining > 0) await sleep(remaining); };
  const consume = async (model: Model, participant: number, prompt: string, useResearch = false) => { calls++; const result = await askParticipant(model, names[participant], CHAT_VOICES[participant % CHAT_VOICES.length], prompt, useResearch, waitMs => emit({ type: 'activity', status: 'rate_limit', participant, model: model.id, screen_name: names[participant], message: waitMessage(waitMs) })); cost += Number(result.usage.cost ?? 0); return result; };
  const addInterpretation = async (phase: string, rotation: number) => { emit({ type: 'activity', phase: 'interpretation', rotation, model: INTERPRETER_MODEL, screen_name: 'Luna', message: 'checking the room…' }); calls++; try { const result = await interpret(question, models.length, registered, messages, names, waitMs => emit({ type: 'activity', status: 'rate_limit', participant: 'room', model: INTERPRETER_MODEL, screen_name: 'Room', message: waitMessage(waitMs) })); cost += Number(result.usage.cost ?? 0); const event = { type: 'interpretation', phase, rotation, model: INTERPRETER_MODEL, screen_name: 'Luna', decisions: result.decisions, usage: result.usage }; emit(event); return result.decisions; } catch (error) { cost += Number((error as any)?.usage?.cost ?? 0); throw error; } };
  const finish = (final: ChatEvent) => { final.outcome = outcomeText(final, models.length); final.observer = 'Luna'; emit(final); return { events: [...messages, final], final }; };
  const transcript = () => messages.map(m => `${m.participant === 'human' ? 'You' : names[m.participant]}: ${m.message}`).join('\n');
  try {
    const opening: PromiseSettledResult<ChatEvent>[] = [];
    for (let participant = 0; participant < models.length; participant++) {
      const model = models[participant];
      try {
        const typingStarted = Date.now();
        emit({ type: 'activity', phase: 'opening', participant, model: model.id, screen_name: names[participant], message: research ? 'is looking something up…' : 'is typing…' });
        const result = await consume(model, participant, openingPrompt(question, transcript(), research), research);
        await pace(typingStarted, result.message);
        const event = { type: 'message', phase: 'opening', rotation: 0, participant, model: model.id, screen_name: names[participant], message: result.message, usage: result.usage };
        messages.push(event); emit(event); opening.push({ status: 'fulfilled', value: event });
      } catch (reason) { opening.push({ status: 'rejected', reason }); }
    }
    const failedOpening = opening.find(result => result.status === 'rejected'); if (failedOpening) throw failedOpening.reason;
    const openingDecisions = await addInterpretation('opening', 0);
    if (mode === 'consensus') { const proposal = latestSupportUnanimous(openingDecisions, models.length); if (proposal) return finish({ type: 'final', status: 'CONSENSUS', mode, proposal, cost, calls }); }
    for (let rotation = 1; rotation <= debateTurns; rotation++) {
      for (let participant = 0; participant < models.length; participant++) {
        const typingStarted = Date.now();
        emit({ type: 'activity', phase: 'chat', rotation, participant, model: models[participant].id, screen_name: names[participant], message: 'is typing…' });
        const result = await consume(models[participant], participant, debatePrompt(question, transcript()));
        await pace(typingStarted, result.message);
        const event = { type: 'message', phase: 'chat', rotation, participant, model: models[participant].id, screen_name: names[participant], message: result.message, usage: result.usage };
        messages.push(event); emit(event);
      }
      const decisions = await addInterpretation('chat', rotation); if (mode === 'consensus') { const proposal = latestSupportUnanimous(decisions, models.length); if (proposal) return finish({ type: 'final', status: 'CONSENSUS', mode, proposal, cost, calls }); }
    }
    if (mode === 'vote') {
      const proposalList = formatProposalList(registered.values());
      for (let participant = 0; participant < models.length; participant++) {
        const model = models[participant]; const typingStarted = Date.now();
        emit({ type: 'activity', phase: 'ballot', participant, model: model.id, screen_name: names[participant], message: 'is typing…' });
        const result = await consume(model, participant, ballotPrompt(question, transcript(), proposalList));
        await pace(typingStarted, result.message);
        const event = { type: 'message', phase: 'ballot', rotation: debateTurns + 1, participant, model: model.id, screen_name: names[participant], message: result.message, usage: result.usage };
        messages.push(event); emit(event);
      }
      const decisions = await addInterpretation('ballot', debateTurns + 1); const winner = voteWinner(decisions, new Set(registered.keys())); const supportCount = decisions.filter(decision => decision.type === 'support').length; return finish(winner ? { type: 'final', status: 'VOTE', mode, proposal: winner.proposal, vote_count: winner.count, cost, calls } : { type: 'final', status: supportCount ? 'TIE' : 'NO_WINNER', mode, cost, calls });
    }
    return finish({ type: 'final', status: 'NO_CONSENSUS', mode, cost, calls });
  } catch (error) { const errorEvent = { type: 'error', error: error instanceof Error ? error.message : 'Run failed', cost, calls, max_calls: maxCalls }; emit(errorEvent); const result = finish({ type: 'final', status: 'INVALID_RUN', mode, cost, calls }); result.events.splice(-1, 0, errorEvent); return result; }
}
