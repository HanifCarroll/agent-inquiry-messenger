# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a solo researcher evaluating an idea or question. They want to assemble a small panel of language models, watch them challenge one another, and intervene when useful.

## Product Purpose

Agent Inquiry Messenger runs a live multi-model discussion whose goal is a shared answer, not a collection of independent responses. A successful session makes the path from competing positions to agreement easy to follow and leaves a saved transcript.

## Positioning

Models participate in one shared chronological conversation and argue in ordinary text. GPT-5.6 Luna interprets their positions without choosing the answer; the server detects agreement or counts votes. The user can join the room without counting as a model vote.

## Operating Context

The user starts with a research question, selects two to five OpenRouter models, chooses a discussion length, and may enable Exa research. They then watch the room live, monitor cost and call usage, and can send messages into the discussion.

## Capabilities and Constraints

- SvelteKit 5 application run with Bun.
- OpenRouter supplies the live model catalog, pricing, and model calls.
- Exa research is optional and off by default.
- Sessions use sequential opening calls and sequential turns so one agent speaks at a time.
- GPT-5.6 Luna interprets participant positions once after each complete round.
- Agreement requires unanimous interpreted support for one answer; vote mode counts interpreted ballots mechanically.
- Human messages inform later model turns but do not count as calls or agent votes.
- Completed transcripts are saved locally as JSONL.

## Brand Commitments

The product is called Agent Inquiry Messenger. It should preserve the recognizable character of classic AIM while prioritizing clear modern product UX over pixel-perfect historical reproduction.

## Evidence on Hand

The working product and its current AIM-inspired interface are implemented in `src/routes/+page.svelte`. No customer claims, usage benchmarks, or public proof should be invented.

## Product Principles

- Make convergence and disagreement legible at a glance.
- Keep starting a thoughtful room fast despite the underlying model controls.
- Preserve the feeling of joining a live group chat.
- Keep actual cost and research behavior transparent.
- Let the researcher participate without confusing their input with a model vote.

## Accessibility & Inclusion

The interface must remain keyboard-operable, maintain visible focus states, expose live updates accessibly, and work at desktop and mobile viewport sizes.
