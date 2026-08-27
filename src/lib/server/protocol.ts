import { OpenRouter } from '@openrouter/sdk';
import type { ChatRequest, ChatRequestEffort, ChatResult, Model as SDKModel } from '@openrouter/sdk/models';
import { personalityFor, personalityIds as generatePersonalityIds, screenNames, validPersonalityIds, validScreenNames, type PersonalityId } from '../identity';

export type Model = SDKModel;
export type DecisionMode = 'consensus' | 'vote';
export type Decision = { participant: number; type: 'propose' | 'support' | 'undecided'; proposal: string };
export type ChatEvent = Record<string, any>;
export const INTERPRETER_MODEL = 'z-ai/glm-5.3-flash';
export const HOSTED_MODEL_ID = 'deepseek/deepseek-v4-flash';
export const HOSTED_PARTICIPANT_COUNT = 3;
export const HOSTED_DEBATE_TURNS = 8;
export const INTERPRETER_REASONING: ChatRequestEffort = 'low';
export const USER_KEY_HEADER = 'x-openrouter-key';

export function selectedModelsAllowed(ids: string[], guest: boolean) {
  return !guest || (ids.length === HOSTED_PARTICIPANT_COUNT && ids.every(id => id === HOSTED_MODEL_ID));
}
export function requestApiKey(userKey: string | null | undefined, env?: Record<string, string | undefined>) { return { apiKey: userKey?.trim() || key(env), guest: !userKey?.trim() }; }
export function runKeyRouting(participantApiKey: string, interpreterApiKey: string) { return { participant: participantApiKey, interpreter: interpreterApiKey }; }

export function formatProposalList(proposals: Iterable<string>): string {
  const texts = [...proposals];
  return texts.length ? texts.map(text => `- ${text}`).join('\n') : '(none)';
}

export function key(env?: Record<string, string | undefined>): string {
  const value = env?.OPENROUTER_API_KEY ?? (globalThis as any).process?.env?.OPENROUTER_API_KEY;
  if (!value) throw new Error('OpenRouter is not connected. Add OPENROUTER_API_KEY to the server environment.');
  return value;
}

// Proposal IDs are only internal map keys; keeping this synchronous avoids a Node-only crypto dependency in Workers.
export function proposalId(proposal: string): string { let hash = 2166136261; for (const char of proposal) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, '0'); }
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
  const reset = header('x-ratelimit-reset') ?? header('x-rate-limit-reset');
  if (nonempty(reset)) {
    const resetValue = Number(reset);
    if (Number.isFinite(resetValue) && resetValue >= 0) {
      const resetAt = resetValue < 1e12 ? resetValue * 1000 : resetValue;
      return Math.max(0, resetAt - now) + RETRY_BUFFER_MS;
    }
    const resetAt = Date.parse(reset);
    if (Number.isFinite(resetAt)) return Math.max(0, resetAt - now) + RETRY_BUFFER_MS;
  }
  return 60_000 + RETRY_BUFFER_MS;
}

const MAX_RATE_LIMIT_RETRIES = 3;
const PARTICIPANT_TIMEOUT_MS = 61_000;
const GUEST_PARTICIPANT_TIMEOUT_MS = 30_000;
export async function retryRateLimited<T>(operation: () => Promise<T>, onRateLimit?: (waitMs: number) => void, waitFor = rateLimitWaitMs, sleepFor = sleep): Promise<T> {
  for (let retry = 0; ; retry++) {
    try { return await operation(); }
    catch (error) {
      const waitMs = waitFor(error);
      if (waitMs === null || retry >= MAX_RATE_LIMIT_RETRIES) throw error;
      onRateLimit?.(waitMs);
      await sleepFor(waitMs);
    }
  }
}

export function responseDelayMs(message: string, random = Math.random()): number {
  const wordDelay = Math.min((message.match(/\S+/g)?.length ?? 0) * 75, 1500);
  return 2500 + wordDelay + Math.floor(random * 1800);
}

export class InterpreterError extends Error {
  constructor(message: string, public usage: Record<string, any> = { cost: 0 }) { super(`The room referee could not read the room: ${message}`); }
}

function openRouter(apiKey: string) {
  return new OpenRouter({ apiKey, httpReferer: 'https://github.com/HanifCarroll/agent-inquiry-messenger', appTitle: 'Agent Inquiry Messenger', retryConfig: { strategy: 'backoff', backoff: { initialInterval: 500, maxInterval: 3000, exponent: 2, maxElapsedTime: 10000 }, retryConnectionErrors: true } });
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
const INTERPRETER_SYSTEM = `You are the room referee, a neutral transcript clerk. Read the ordinary group chat and report each participant's latest main position. Never assess answer quality, choose an answer, or count the human. Resolve conversational references such as "that one," "you sold me," or "still going with mine" only when the transcript makes the referent clear; otherwise mark the participant undecided. A caveat or exception does not replace someone's main position unless they actually switch their answer. For support, return the exact matching registered proposal text. For propose, extract a concise complete answer actually advanced by that participant. Return an object with a decisions array containing exactly one decision for every online participant; offline participants may be omitted.`;

export function participantReasoning(model: Pick<Model, 'reasoning'>): ChatRequestEffort {
  if (!model.reasoning?.mandatory) return 'none';
  return model.reasoning.supportedEfforts?.filter(effort => effort && effort !== 'none').at(-1) ?? 'minimal';
}

async function request(apiKey: string, model: string, messages: ChatRequest['messages'], plugin = false, structured = false, reasoning: ChatRequestEffort = 'none', onRateLimit?: (waitMs: number) => void) {
  const chatRequest: any = { model, messages, maxTokens: structured ? 2000 : 100, stream: false, reasoning: { effort: reasoning }, ...(plugin ? { plugins: [{ id: 'web', engine: 'exa', maxResults: 5 }] } : {}) };
  if (structured) {
    chatRequest.responseFormat = { type: 'json_schema', jsonSchema: { name: 'room_decisions', strict: true, schema: interpreterSchema } };
    chatRequest.provider = { requireParameters: true };
  }
  const response = await retryRateLimited(
    () => openRouter(apiKey).chat.send({ chatRequest }, { retryCodes: ['5XX'] }),
    onRateLimit
  );
  const result = response as ChatResult;
  const content = result.choices?.[0]?.message?.content;
  return { content: typeof content === 'string' ? content : '', usage: result.usage ?? { cost: 0 } };
}

export const SYSTEM_PROMPT = `You are a person chatting with a few other agents about the user's question. Have a real opinion, pay attention to what everyone has said, and try to convince them when you disagree. Change your mind only when something in the chat actually persuades you.

Write the next thing you would actually type in an AIM group chat. React to one point instead of recapping the room. It is fine to joke, ask a quick question, hesitate, disagree, or say someone changed your mind. Do not use formal debate language such as "I support," "my proposal," "the stronger case," "listed options," or "final ballot."

Keep it very short: at most two short sentences and no more than 35 words total. Use lowercase only. Make it readable as early-2000s AIM chat: use fairly aggressive abbreviations such as imo, idk, bc, u, tho, lol, haha, or brb, plus an occasional intentional harmless misspelling, but not every word or every reply. Avoid modern emojis and current internet slang.

Return plain text only. Never use Markdown, JSON, labels, decision metadata, or your own screen name as a prefix. Cite only sources you actually used.`;
export function openingPrompt(question: string, transcript: string, research: boolean) { return `Room question:\n${question}\n\nChat so far:\n${transcript || '(nobody has said anything yet)'}\n\nRead the whole chat before typing. ${research ? 'Look up what you need first.' : 'Use what you know.'} Give your honest first reaction or answer. If someone already spoke, respond to what they actually said.`; }
export function debatePrompt(question: string, transcript: string) { return `Room question:\n${question}\n\nChat so far:\n${transcript}\n\nRead everything above, including the newest message, then type the next natural reply. Push back, add one useful thought, ask something, or admit if somebody changed your mind. Do not summarize the room.`; }
export function ballotPrompt(question: string, transcript: string, proposalList: string) { return `Room question:\n${question}\n\nChat so far:\n${transcript}\n\nAnswers people have mentioned:\n${proposalList}\n\nRead everything above. Send one last normal chat message saying what you are going with. Do not call it a vote, ballot, proposal, or support.`; }

function parseJson(text: string): unknown { return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); }
export function validateInterpretation(value: unknown, participantCount: number, registered: Map<string, string> | Set<string>, offlineParticipants = new Set<number>()): Decision[] {
  const raw = value && typeof value === 'object' && 'decisions' in value ? (value as any).decisions : null;
  if (!Array.isArray(raw) || raw.length > participantCount) throw new InterpreterError('the room state was incomplete');
  const decisions = raw.map((item: any) => ({ participant: item?.participant, type: item?.type, proposal: item?.proposal }));
  const ids = new Set<number>();
  for (const d of decisions) {
    if (!Number.isInteger(d.participant) || d.participant < 0 || d.participant >= participantCount || ids.has(d.participant)) throw new InterpreterError('one or more agent positions were missing');
    ids.add(d.participant);
    if (!['propose', 'support', 'undecided'].includes(d.type) || typeof d.proposal !== 'string') throw new InterpreterError('one or more agent positions were unclear');
  }
  for (let participant = 0; participant < participantCount; participant++) if (!ids.has(participant)) decisions.push({ participant, type: 'undecided', proposal: '' });
  decisions.sort((a, b) => a.participant - b.participant);
  const available = new Map<string, string>();
  if (registered instanceof Map) for (const [id, text] of registered) available.set(id, text);
  for (const d of decisions.filter(d => d.type === 'propose' && nonempty(d.proposal))) available.set(proposalId(d.proposal), d.proposal);
  return decisions.map(d => {
    if (d.type === 'undecided' || (d.type === 'propose' && !nonempty(d.proposal))) return { ...d, type: 'undecided' as const, proposal: '' };
    if (d.type === 'support' && available.get(proposalId(d.proposal)) !== d.proposal) return { ...d, type: 'undecided' as const, proposal: '' };
    return d;
  });
}

export function applyInterpretation(value: unknown, participantCount: number, registered: Map<string, string>, offlineParticipants = new Set<number>()): Decision[] {
  const decisions = validateInterpretation(value, participantCount, registered, offlineParticipants);
  for (const d of decisions) if (d.type === 'propose') registered.set(proposalId(d.proposal), d.proposal);
  return decisions;
}

export function normalizeParticipantContent(content: string): string { return content.trim().toLowerCase(); }

export async function askParticipant(apiKey: string, model: Model, screenName: string, voice: string, prompt: string, research: boolean, onRateLimit?: (waitMs: number) => void) {
  let result;
  try { result = await request(apiKey, model.id, [{ role: 'system', content: `${SYSTEM_PROMPT}\n\nYour screen name is ${screenName}, but do not type it in your messages. ${voice}` }, { role: 'user', content: prompt }], research, false, participantReasoning(model), onRateLimit); }
  catch (error) { throw new Error(`${screenName} could not reply: ${requestErrorText(error)}`); }
  const message = normalizeParticipantContent(result.content);
  if (!message) throw new Error(`Empty response from ${screenName}`);
  return { message, usage: result.usage };
}

export async function interpret(apiKey: string, question: string, participantCount: number, registered: Map<string, string>, transcriptMessages: ChatEvent[], names: string[], onRateLimit?: (waitMs: number) => void, offlineParticipants = new Set<number>()) {
  const proposals = formatProposalList([...registered.values()]);
  const transcript = transcriptMessages.map(message => `${message.participant === 'human' ? 'Human (not a participant)' : `Participant ${message.participant} (${names[message.participant]})`}: ${message.message}`).join('\n');
  const result = await request(apiKey, INTERPRETER_MODEL, [{ role: 'system', content: INTERPRETER_SYSTEM }, { role: 'user', content: `Question:\n${question}\n\nOffline participant IDs (do not invent positions for them): ${[...offlineParticipants].join(', ') || '(none)'}\n\nRegistered proposals (exact text):\n${proposals}\n\nFull chat in chronological order:\n${transcript}\n\nReport every online participant's latest current position now; offline participants may be omitted.` }], false, true, INTERPRETER_REASONING, onRateLimit);
  let parsed: unknown;
  try { parsed = parseJson(result.content); } catch { throw new InterpreterError('the latest positions were unclear', result.usage); }
  try { return { decisions: applyInterpretation(parsed, participantCount, registered, offlineParticipants), usage: result.usage }; } catch (error) { if (error instanceof InterpreterError) error.usage = result.usage; throw error; }
}

export function chatCapable(model: Pick<Model, 'architecture'>) {
  const input = model.architecture?.inputModalities ?? [];
  const output = model.architecture?.outputModalities ?? [];
  return input.includes('text') && output.length === 1 && output[0] === 'text';
}
export async function catalog(apiKey = key(), guest = false): Promise<Model[]> { const pages = await openRouter(apiKey).models.list(); const models: Model[] = []; for await (const page of pages) models.push(...page.result.data); return models.filter(model => chatCapable(model) && !model.id.endsWith(':batch') && (!guest || model.id === HOSTED_MODEL_ID)); }
export function price(model: Model) { const perMillion = (value: string) => { const amount = Number(value) * 1_000_000; return Number.isFinite(amount) && amount >= 0 ? amount : null; }; return { input: perMillion(model.pricing.prompt), output: perMillion(model.pricing.completion) }; }

export function latestSupportUnanimous(decisions: Decision[] | ChatEvent[], participantCount: number, offlineParticipants = new Set<number>()): string | null {
  const latest: any[] = Array.from({ length: participantCount });
  for (const item of decisions) if (Number.isInteger(item.participant) && item.participant >= 0 && item.participant < participantCount) latest[item.participant] = item;
  const online = Array.from({ length: participantCount }, (_, participant) => participant).filter(participant => !offlineParticipants.has(participant));
  if (online.some(participant => latest[participant]?.type !== 'support')) return null;
  const proposals = online.map(participant => latest[participant].proposal);
  return proposals.length > 0 && proposals.every(proposal => proposal === proposals[0]) ? proposals[0] : null;
}
export function canReachConsensus(mode: DecisionMode, completedRounds: number, decisions: Decision[], participantCount: number, offlineParticipants = new Set<number>()) { return mode === 'consensus' && completedRounds >= 4 ? latestSupportUnanimous(decisions, participantCount, offlineParticipants) : null; }
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

export async function run(participantApiKey: string, interpreterApiKey: string, question: string, models: Model[], debateTurns: number, research: boolean, mode: DecisionMode, emit: (event: ChatEvent) => void, messages: ChatEvent[] = [], aliases?: string[], personalityIds?: PersonalityId[], beforeReply?: () => Promise<void>, participantReply = askParticipant, replacementModels: Model[] = []) {
  const keys = runKeyRouting(participantApiKey, interpreterApiKey);
  const registered = new Map<string, string>(); const started = new Date().toISOString(); const names = validScreenNames(aliases, models.length) ? aliases : screenNames(models.length); const chosenPersonalityIds = validPersonalityIds(personalityIds, models.length) ? personalityIds : generatePersonalityIds(models.length);
  const maxCalls = (models.length + 1) * (1 + debateTurns + (mode === 'vote' ? 1 : 0)); let cost = 0; let calls = 0;
  emit({ type: 'run', question, models: models.map(m => m.id), screen_names: names, personality_ids: chosenPersonalityIds, interpreter: INTERPRETER_MODEL, debate_turns: debateTurns, research, mode, started_at: started, max_calls: maxCalls });
  const waitMessage = (waitMs: number) => `got rate-limited — retrying in ${Math.ceil(waitMs / 1000)}s…`;
  const pace = async (startedAt: number, message: string) => { const remaining = responseDelayMs(message) - (Date.now() - startedAt); if (remaining > 0) await sleep(remaining); };
  const consume = async (model: Model, participant: number, prompt: string, useResearch = false, failOnRateLimit = false) => { calls++; const result = await participantReply(keys.participant, model, names[participant], personalityFor(chosenPersonalityIds[participant]).prompt, prompt, useResearch, waitMs => { emit({ type: 'activity', status: 'rate_limit', participant, model: model.id, model_name: model.name, screen_name: names[participant], message: waitMessage(waitMs) }); if (failOnRateLimit) throw new Error(`${model.name} was rate-limited`); }); cost += Number(result.usage?.cost ?? 0); return result; };
  const addInterpretation = async (phase: string, rotation: number) => { emit({ type: 'activity', phase: 'interpretation', rotation, model: INTERPRETER_MODEL, screen_name: 'Room referee', message: 'checking the room…' }); calls++; try { const result = await interpret(keys.interpreter, question, models.length, registered, messages, names, waitMs => emit({ type: 'activity', status: 'rate_limit', participant: 'room', model: INTERPRETER_MODEL, screen_name: 'Room referee', message: waitMessage(waitMs) }), inactive); cost += Number(result.usage.cost ?? 0); const event = { type: 'interpretation', phase, rotation, model: INTERPRETER_MODEL, screen_name: 'Room referee', decisions: result.decisions, usage: result.usage }; emit(event); return result.decisions; } catch (error) { cost += Number((error as any)?.usage?.cost ?? 0); throw error; } finally { emit({ type: 'activity', status: 'done', phase, rotation, participant: 'room', model: INTERPRETER_MODEL, screen_name: 'Room referee', message: '' }); } };
  const finish = (final: ChatEvent) => { final.outcome = outcomeText(final, models.length); final.observer = 'Room referee'; emit(final); return { events: [...messages, final], final }; };
  const transcript = () => messages.map(m => `${m.participant === 'human' ? 'You' : names[m.participant]}: ${m.message}`).join('\n');
  const inactive = new Set<number>(); const seatModels = [...models]; let replacementIndex = 0;
  const reply = async (phase: string, rotation: number, participant: number, prompt: string, useResearch = false) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const model = seatModels[participant];
      emit({ type: 'activity', phase, rotation, participant, model: model.id, model_name: model.name, screen_name: names[participant], message: useResearch ? 'is looking something up…' : 'is typing…' });
      try {
        const result = await new Promise<Awaited<ReturnType<typeof consume>>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${names[participant]} timed out`)), replacementModels.length ? GUEST_PARTICIPANT_TIMEOUT_MS : PARTICIPANT_TIMEOUT_MS);
          (async () => { try { await beforeReply?.(); resolve(await consume(model, participant, prompt, useResearch, replacementModels.length > 0)); } catch (error) { reject(error); } finally { clearTimeout(timer); } })();
        });
        await pace(Date.now(), result.message);
        return result;
      } catch (reason) {
        const replacement = replacementModels.slice(replacementIndex).find(candidate => !seatModels.some(used => used.id === candidate.id));
        if (attempt === 0 && replacement) {
          replacementIndex = replacementModels.indexOf(replacement) + 1;
          seatModels[participant] = replacement;
          emit({ type: 'error', recovered: true, error: reason instanceof Error ? reason.message : `${names[participant]} could not reply`, participant, model: model.id, model_name: model.name, replacement_model: replacement.id, replacement_model_name: replacement.name });
          continue;
        }
        inactive.add(participant);
        emit({ type: 'error', offline: true, error: reason instanceof Error ? reason.message : `${names[participant]} could not reply`, participant, model: model.id, model_name: model.name });
        return null;
      } finally {
        emit({ type: 'activity', status: 'done', phase, rotation, participant, model: model.id, model_name: model.name, screen_name: names[participant], message: '' });
      }
    }
    return null;
  };
  const activeCount = () => models.length - inactive.size;
  const addMessage = (phase: string, rotation: number, participant: number, result: Awaited<ReturnType<typeof consume>>) => {
    const event = { type: 'message', phase, rotation, participant, model: seatModels[participant].id, model_name: seatModels[participant].name, screen_name: names[participant], message: result.message, usage: result.usage };
    messages.push(event); emit(event);
  };
  try {
    for (let participant = 0; participant < models.length; participant++) {
      const result = await reply('opening', 0, participant, openingPrompt(question, transcript(), research), research);
      if (result) addMessage('opening', 0, participant, result);
    }
    if (activeCount() < 2) return finish({ type: 'final', status: 'NO_CONSENSUS', mode, cost, calls });
    await addInterpretation('opening', 0);
    for (let rotation = 1; rotation <= debateTurns; rotation++) {
      for (let participant = 0; participant < models.length; participant++) {
        if (inactive.has(participant)) continue;
        const result = await reply('chat', rotation, participant, debatePrompt(question, transcript()));
        if (result) addMessage('chat', rotation, participant, result);
      }
      if (activeCount() < 2) return finish({ type: 'final', status: 'NO_CONSENSUS', mode, cost, calls });
      const decisions = await addInterpretation('chat', rotation); const proposal = canReachConsensus(mode, rotation, decisions, models.length, inactive); if (proposal) return finish({ type: 'final', status: 'CONSENSUS', mode, proposal, cost, calls });
    }
    if (mode === 'vote') {
      const proposalList = formatProposalList(registered.values());
      for (let participant = 0; participant < models.length; participant++) {
        if (inactive.has(participant)) continue;
        const result = await reply('ballot', debateTurns + 1, participant, ballotPrompt(question, transcript(), proposalList));
        if (result) addMessage('ballot', debateTurns + 1, participant, result);
      }
      const decisions = await addInterpretation('ballot', debateTurns + 1); const winner = voteWinner(decisions, new Set(registered.keys())); const supportCount = decisions.filter(decision => decision.type === 'support').length; return finish(winner ? { type: 'final', status: 'VOTE', mode, proposal: winner.proposal, vote_count: winner.count, cost, calls } : { type: 'final', status: supportCount ? 'TIE' : 'NO_WINNER', mode, cost, calls });
    }
    return finish({ type: 'final', status: 'NO_CONSENSUS', mode, cost, calls });
  } catch (error) { const errorEvent = { type: 'error', error: error instanceof Error ? error.message : 'Run failed', cost, calls, max_calls: maxCalls }; emit(errorEvent); const result = finish({ type: 'final', status: 'INVALID_RUN', mode, cost, calls }); result.events.splice(-1, 0, errorEvent); return result; }
}
