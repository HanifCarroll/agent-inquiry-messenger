import { expect, test } from 'bun:test';
import { applyInterpretation, ballotPrompt, canReachConsensus, chatCapable, debatePrompt, formatProposalList, HOSTED_DEBATE_TURNS, HOSTED_MODEL_ID, HOSTED_PARTICIPANT_COUNT, INTERPRETER_MODEL, INTERPRETER_REASONING, InterpreterError, latestSupportUnanimous, normalizeParticipantContent, requestApiKey, openingPrompt, retryRateLimited, run, runKeyRouting, outcomeText, participantReasoning, price, proposalId, rateLimitWaitMs, requestErrorText, responseDelayMs, selectedModelsAllowed, SYSTEM_PROMPT, validateInterpretation, voteWinner } from '../src/lib/server/protocol';
import { isNearBottom } from '../src/lib/chat-ui';
import { CHAT_VOICES, SCREEN_NAME_POOL, personalityIds, validPersonalityIds, screenNames, validScreenNames } from '../src/lib/identity';
import type { Model } from '../src/lib/server/protocol';
import { parseJsonl, validRunFilename } from '../src/lib/server/storage';
import { registerSession, sendToSession } from '../src/lib/server/sessions';

const proposal = 'The room should publish a source-linked summary.';
const other = 'The room should publish a concise answer.';
const registered = new Map([[proposalId(proposal), proposal]]);

const decision = (participant: number, type: 'propose' | 'support' | 'undecided', text = '') => ({ participant, type, proposal: text });

test('validates and applies room-referee decisions, registering proposals before supports', () => {
  const next = 'The room should publish both a summary and its sources.';
  expect(applyInterpretation({ decisions: [decision(0, 'propose', next), decision(1, 'support', next)] }, 2, new Map())).toEqual([decision(0, 'propose', next), decision(1, 'support', next)]);
  expect(validateInterpretation({ decisions: [decision(0, 'support', 'Not registered'), decision(1, 'undecided')] }, 2, registered)).toEqual([decision(0, 'undecided'), decision(1, 'undecided')]);
  expect(() => validateInterpretation({ decisions: [decision(0, 'support', proposal), decision(0, 'undecided')] }, 2, registered)).toThrow(/room referee could not read the room/);
});

test('fills omitted room-referee decisions as undecided', () => {
  expect(validateInterpretation({ decisions: [decision(0, 'support', proposal), decision(1, 'support', proposal)] }, 3, registered, new Set([2]))).toEqual([decision(0, 'support', proposal), decision(1, 'support', proposal), decision(2, 'undecided')]);
  expect(validateInterpretation({ decisions: [decision(0, 'undecided')] }, 3, registered)).toEqual([decision(0, 'undecided'), decision(1, 'undecided'), decision(2, 'undecided')]);
});

test('normalizes inconsistent interpreter decisions without creating consensus', () => {
  const decisions = validateInterpretation({ decisions: [decision(0, 'undecided', 'should be discarded'), decision(1, 'propose')] }, 2, registered);
  expect(decisions).toEqual([decision(0, 'undecided'), decision(1, 'undecided')]);
  expect(latestSupportUnanimous(decisions, 2)).toBeNull();
});

test('formats model-visible proposals without internal hashes', () => {
  const text = formatProposalList([proposal, other]);
  expect(text).toBe(`- ${proposal}\n- ${other}`);
  expect(text).not.toContain(proposalId(proposal));
});

test('uses exactly 100 unique short screen names and random selections', () => {
  expect(SCREEN_NAME_POOL).toHaveLength(100);
  expect(new Set(SCREEN_NAME_POOL).size).toBe(100);
  expect(SCREEN_NAME_POOL.every(name => name.length <= 20 && name === name.toLowerCase())).toBe(true);
  expect(screenNames(5)).toSatisfy(names => validScreenNames(names, 5));
  expect(screenNames(100)).toHaveLength(100);
});

test('validates unique personality assignments', () => {
  expect(CHAT_VOICES).toHaveLength(6);
  expect(CHAT_VOICES.every(({ id, label }) => id === id.toLowerCase() && label === label.toLowerCase())).toBe(true);
  expect(validPersonalityIds(personalityIds(3), 3)).toBe(true);
  expect(validPersonalityIds([CHAT_VOICES[0].id, CHAT_VOICES[0].id], 2)).toBe(false);
  expect(validPersonalityIds([CHAT_VOICES[0].id], 2)).toBe(false);
  expect(validPersonalityIds(['not-a-personality'], 1)).toBe(false);
});

test('validates supplied aliases at the trust boundary', () => {
  expect(validScreenNames(SCREEN_NAME_POOL.slice(0, 2), 2)).toBe(true);
  expect(validScreenNames([SCREEN_NAME_POOL[0], SCREEN_NAME_POOL[0]], 2)).toBe(false);
  expect(validScreenNames(['not-allowed'], 1)).toBe(false);
  expect(validScreenNames(SCREEN_NAME_POOL.slice(0, 2), 3)).toBe(false);
});

test('requires short ordinary AIM chat without visible decision protocol', () => {
  expect(SYSTEM_PROMPT).toContain('no more than 35 words total');
  expect(SYSTEM_PROMPT).toContain('Use lowercase only');
  expect(SYSTEM_PROMPT).toContain('intentional harmless misspelling');
  expect(SYSTEM_PROMPT).toContain('plain text only');
  expect(SYSTEM_PROMPT).toContain('Do not use formal debate language');
  expect(SYSTEM_PROMPT).toContain('Never use Markdown, JSON, labels, decision metadata');
});

test('guarantees participant content is lowercase before emitting it', () => {
  expect(normalizeParticipantContent('  Hi There, IMO!  ')).toBe('hi there, imo!');
});

test('shows each participant the room transcript before every reply', () => {
  const transcript = 'pixelpickle: my pick is Superbad';
  expect(openingPrompt('Best comedy?', transcript, false)).toContain(transcript);
  expect(debatePrompt('Best comedy?', transcript)).toContain('including the newest message');
  expect(ballotPrompt('Best comedy?', transcript, '- Superbad')).toContain(transcript);
});

test('uses the lowest allowed reasoning effort only when reasoning is mandatory', () => {
  expect(participantReasoning({})).toBe('none');
  expect(participantReasoning({ reasoning: { mandatory: false } })).toBe('none');
  expect(participantReasoning({ reasoning: { mandatory: true, supportedEfforts: ['high', 'low'] } })).toBe('low');
  expect(participantReasoning({ reasoning: { mandatory: true, supportedEfforts: null } })).toBe('minimal');
});

test('unanimity uses every participant latest interpreted decision', () => {
  expect(latestSupportUnanimous([decision(0, 'support', proposal), decision(1, 'support', proposal)], 2)).toBe(proposal);
  expect(latestSupportUnanimous([decision(0, 'support', proposal), decision(0, 'propose', other), decision(1, 'support', proposal)], 2)).toBeNull();
  expect(latestSupportUnanimous([decision(0, 'support', proposal), decision(1, 'support', other)], 2)).toBeNull();
});

test('counts a unique winner, tie, and no-support ballot mechanically', () => {
  const ids = new Set([proposalId(proposal), proposalId(other)]);
  expect(voteWinner([decision(0, 'support', proposal), decision(1, 'support', proposal), decision(2, 'support', other)], ids)).toEqual({ proposal, count: 2 });
  expect(voteWinner([decision(0, 'support', proposal), decision(1, 'support', other)], ids)).toBeNull();
  expect(voteWinner([decision(0, 'undecided'), decision(1, 'undecided')], ids)).toBeNull();
});

test('states the final outcome concisely', () => {
  expect(outcomeText({ status: 'CONSENSUS', proposal }, 3)).toBe(`Everyone agreed: ${proposal}`);
  expect(outcomeText({ status: 'VOTE', proposal, vote_count: 2 }, 3)).toBe(`${proposal} won with 2 of 3 votes.`);
  expect(outcomeText({ status: 'TIE' }, 3)).toBe('the vote ended in a tie.');
});

test('enforces the fixed hosted DeepSeek guest room while preserving connected choices', () => {
  expect(HOSTED_MODEL_ID).toBe('deepseek/deepseek-v4-flash');
  expect(HOSTED_PARTICIPANT_COUNT).toBe(3);
  expect(HOSTED_DEBATE_TURNS).toBe(8);
  expect(selectedModelsAllowed(Array(3).fill(HOSTED_MODEL_ID), true)).toBe(true);
  expect(selectedModelsAllowed([HOSTED_MODEL_ID], true)).toBe(false);
  expect(selectedModelsAllowed(['openai/gpt-5.6-luna'], true)).toBe(false);
  expect(selectedModelsAllowed(['openai/gpt-5.6-luna'], false)).toBe(true);
  expect(INTERPRETER_MODEL).toBe('z-ai/glm-5.3-flash');
  expect(INTERPRETER_REASONING).toBe('low');
  expect(new InterpreterError('unclear').message).toContain('room referee');
  expect(requestApiKey('sk-or-user', { OPENROUTER_API_KEY: 'sk-or-server' })).toEqual({ apiKey: 'sk-or-user', guest: false });
  expect(requestApiKey(null, { OPENROUTER_API_KEY: 'sk-or-server' })).toEqual({ apiKey: 'sk-or-server', guest: true });
  expect(runKeyRouting('sk-or-user', 'sk-or-server')).toEqual({ participant: 'sk-or-user', interpreter: 'sk-or-server' });
});

test('allows unanimity only after four completed debate rounds and never in vote mode', () => {
  const unanimous = [decision(0, 'support', proposal), decision(1, 'support', proposal)];
  expect(canReachConsensus('consensus', 3, unanimous, 2)).toBeNull();
  expect(canReachConsensus('consensus', 4, unanimous, 2)).toBe(proposal);
  expect(canReachConsensus('vote', 12, unanimous, 2)).toBeNull();
});

test('accepts text-only chat models, including text-only GPT-OSS, and rejects multimodal output', () => {
  const text = { architecture: { inputModalities: ['text'], outputModalities: ['text'], modality: 'text->text' }, supportedParameters: [] } as any;
  expect(chatCapable(text)).toBe(true);
  expect(chatCapable({ id: 'openai/gpt-oss-20b:free', ...text })).toBe(true);
  expect(chatCapable({ architecture: { inputModalities: ['text'], outputModalities: ['text', 'audio'], modality: 'text->text+audio' } })).toBe(false);
});

test('marks OpenRouter placeholder prices as unavailable', () => {
  const model = { pricing: { prompt: '-1', completion: '0.000001' } } as Model;
  expect(price(model)).toEqual({ input: null, output: 1 });
});

test('shows the useful upstream provider error', () => {
  expect(requestErrorText({ error: { metadata: { raw: 'This model is temporarily rate-limited.' } } })).toBe('This model is temporarily rate-limited.');
  expect(requestErrorText(new Error('Provider returned error'))).toBe('Provider returned error');
});

test('uses OpenRouter reset timing for rate limits and a one-minute fallback', () => {
  expect(rateLimitWaitMs({ statusCode: 429, headers: new Headers({ 'retry-after': '3' }) }, 0)).toBe(3250);
  expect(rateLimitWaitMs({ statusCode: 429, headers: new Headers({ 'x-ratelimit-reset': '1700000003' }) }, 1700000000000)).toBe(3250);
  expect(rateLimitWaitMs(new Error('Rate limit exceeded: new accounts are limited to 10 requests per minute.'))).toBe(60250);
  expect(rateLimitWaitMs(new Error('Provider returned error'))).toBeNull();
});

test('does not hang forever on repeated rate limits', async () => {
  let attempts = 0;
  const waits: number[] = [];
  await expect(retryRateLimited(
    async () => { attempts++; throw { statusCode: 429 }; },
    waitMs => waits.push(waitMs),
    () => 0,
    async () => {}
  )).rejects.toMatchObject({ statusCode: 429 });
  expect(attempts).toBe(4);
  expect(waits).toEqual([0, 0, 0]);
});

test('paces replies and follows the transcript only near the bottom', () => {
  expect(responseDelayMs('short reply', 0)).toBe(2650);
  expect(responseDelayMs('short reply', 0.999)).toBeGreaterThan(4400);
  expect(isNearBottom({ scrollHeight: 1000, scrollTop: 570, clientHeight: 400 })).toBe(true);
  expect(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 400 })).toBe(false);
});

test('replaces a failed first model and emits the replacement reply', async () => {
  const model = (id: string) => ({ id, name: id, pricing: { prompt: '0', completion: '0' }, architecture: { inputModalities: ['text'], outputModalities: ['text'] } }) as Model;
  const events: any[] = [];
  const result = await run('participant', 'interpreter', 'question', [model('a'), model('b')], 1, false, 'consensus', event => events.push(event), [], ['alpha', 'bravo'], personalityIds(2), undefined, async (_key, selected, _name, _voice, _prompt, _research, onRateLimit) => {
    if (selected.id === 'a') onRateLimit?.(60_000);
    if (selected.id !== 'c') throw new Error('participant model failed');
    return { message: 'i agree', usage: { cost: 0 } };
  }, [model('c')]);
  expect(result.final.status).toBe('NO_CONSENSUS');
  expect(events.some(event => event.type === 'message' && event.participant === 0 && event.model === 'c')).toBe(true);
  expect(events.some(event => event.type === 'activity' && event.participant === 0 && event.model === 'c')).toBe(true);
  expect(events.filter(event => event.type === 'activity' && event.participant === 0).at(-1).status).toBe('done');
});

test('delivers messages only to an active run and rejects unsafe filenames', () => {
  let received = '';
  const unregister = registerSession('run-1', message => received = message);
  expect(sendToSession('run-1', 'Hello room')).toBe(true);
  expect(received).toBe('Hello room');
  unregister();
  expect(sendToSession('run-1', 'Too late')).toBe(false);
  expect(validRunFilename('2026-08-20T21-16-10-364Z.jsonl')).toBe(true);
  expect(validRunFilename('../.env.jsonl')).toBe(false);
  expect(() => parseJsonl('{"ok":1}\nnot-json')).toThrow();
});
