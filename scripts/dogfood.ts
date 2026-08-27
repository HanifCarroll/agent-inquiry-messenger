#!/usr/bin/env bun

import { personalityIds as generatePersonalityIds, SCREEN_NAME_POOL } from '../src/lib/identity';
import { GUEST_CHAT_PREFERRED_MODELS } from '../src/lib/server/protocol';

type Json = Record<string, any>;

const args = Bun.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes('--help')) {
  console.log(`Usage: bun run dogfood [options]

Options:
  --url URL          App URL (default: http://127.0.0.1:5173)
  --question TEXT    Room question
  --models IDS       Comma-separated OpenRouter model IDs
  --rounds N         Rounds after opening (default: 1)
  --mode MODE        vote or consensus (default: vote)
  --stall-seconds N  Fail after no events for this long (default: 180)
  --research         Enable web research

Set DOGFOOD_OPENROUTER_KEY to test the connected-user path. Otherwise the
script tests the guest path with the server's free models.`);
  process.exit(0);
}

const baseUrl = (value('--url') ?? process.env.DOGFOOD_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const question = value('--question') ?? 'What harmless superpower would improve everyday life the most?';
const rounds = Number(value('--rounds') ?? 1);
const stallSeconds = Number(value('--stall-seconds') ?? 180);
const mode = value('--mode') ?? 'vote';
const requestedModels = value('--models')?.split(',').map(id => id.trim()).filter(Boolean) ?? [];
const apiKey = process.env.DOGFOOD_OPENROUTER_KEY?.trim();
const headers = { ...(apiKey ? { 'x-openrouter-key': apiKey } : {}) };

if (!Number.isInteger(rounds) || rounds < 1 || rounds > 12) throw new Error('--rounds must be between 1 and 12.');
if (!Number.isFinite(stallSeconds) || stallSeconds < 10) throw new Error('--stall-seconds must be at least 10.');
if (mode !== 'vote' && mode !== 'consensus') throw new Error('--mode must be vote or consensus.');
if (requestedModels.length === 1 || requestedModels.length > 5) throw new Error('--models must contain 2 to 5 IDs.');

async function responseJson(response: Response): Promise<Json> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new Error(`${response.url} did not return JSON. Is this the Agent Inquiry Messenger server?`);
  const data = await response.json() as Json;
  if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`);
  return data;
}

function automaticModels(models: Json[], count = 2): string[] {
  const free = models.filter(model => typeof model.id === 'string' && model.id.endsWith(':free'));
  const candidates = free.length >= count ? free : models;
  candidates.sort((a, b) => {
    const aRank = GUEST_CHAT_PREFERRED_MODELS.indexOf(a.id); const bRank = GUEST_CHAT_PREFERRED_MODELS.indexOf(b.id);
    return (aRank < 0 ? GUEST_CHAT_PREFERRED_MODELS.length : aRank) - (bRank < 0 ? GUEST_CHAT_PREFERRED_MODELS.length : bRank);
  });
  const chosen: Json[] = [];
  const providers = new Set<string>();
  for (const model of candidates) {
    const provider = model.id.split('/')[0];
    if (!providers.has(provider)) { chosen.push(model); providers.add(provider); }
    if (chosen.length === count) break;
  }
  for (const model of candidates) {
    if (!chosen.includes(model)) chosen.push(model);
    if (chosen.length === count) break;
  }
  if (chosen.length < count) throw new Error(`The catalog returned only ${chosen.length} usable model${chosen.length === 1 ? '' : 's'}.`);
  return chosen.map(model => model.id);
}

async function main() {
  const startedAt = Date.now();
  const catalogResponse = await fetch(`${baseUrl}/api/models`, { headers });
  const catalog = await responseJson(catalogResponse);
  const models = requestedModels.length ? requestedModels : automaticModels(catalog.models);
  const screenNames = SCREEN_NAME_POOL.slice(0, models.length);
  const personalityIds = generatePersonalityIds(models.length);

  console.log(`Testing ${baseUrl}`);
  console.log(`Question: ${question}`);
  models.forEach((model, index) => console.log(`  ${screenNames[index]} — ${model}`));
  console.log('');

  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    signal: controller.signal,
    body: JSON.stringify({ question, models, screenNames, personalityIds, participantCount: models.length, debateTurns: rounds, research: args.includes('--research'), mode })
  });
  if (!response.ok) await responseJson(response);
  if (!response.body) throw new Error('The room opened without a transcript stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const messages = new Set<number>();
  let buffer = '';
  let final: Json | undefined;
  let streamError = '';
  let rateLimits = 0;

  const handle = (event: Json) => {
    if (event.type === 'activity') {
      if (event.status === 'rate_limit') rateLimits++;
      console.log(`… ${event.screen_name ?? 'Room'} ${event.message}`);
    } else if (event.type === 'message') {
      if (Number.isInteger(event.participant)) messages.add(event.participant);
      console.log(`${event.screen_name ?? `Agent ${event.participant + 1}`}: ${event.message}`);
    } else if (event.type === 'error') {
      if (event.recovered) {
        console.warn(`RECOVERED: ${event.error ?? 'Agent failed'}; replaced ${event.model} with ${event.replacement_model}`);
      } else {
        streamError = event.error ?? 'Unknown room error';
        console.error(`ERROR: ${streamError}`);
      }
    } else if (event.type === 'final') {
      final = event;
      console.log(`\nLuna: ${event.outcome}`);
    }
  };

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`No room events arrived for ${stallSeconds} seconds.`)); }, stallSeconds * 1000); })
    ]).finally(() => clearTimeout(timer));
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) handle(JSON.parse(line));
  }
  if (buffer.trim()) handle(JSON.parse(buffer));

  if (streamError) throw new Error(streamError);
  if (!final || final.status === 'INVALID_RUN') throw new Error('The room ended without a valid outcome.');
  if (messages.size !== models.length) throw new Error(`Only ${messages.size} of ${models.length} agents replied.`);

  console.log(`\nPASS — ${final.calls ?? '?'} AI requests, $${Number(final.cost ?? 0).toFixed(4)}, ${rateLimits} rate-limit retries, ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

main().catch(error => {
  console.error(`\nFAIL — ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
