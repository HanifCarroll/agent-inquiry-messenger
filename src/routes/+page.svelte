<!--
THESIS: Consensus should feel like an AIM room changing its mind, not a dashboard reporting on agents.
OWN-WORLD: Putty desktop chrome, cobalt title bars, inset white panes, AIM yellow, status green, link blue, and screen-name red.
STORY: Ask one question, assemble a buddy panel, watch proposals gain or lose support, and join the room when useful.
FIRST VIEWPORT: A compact desktop window keeps the room brief and selected buddies beside a searchable live directory; the primary action stays in the status bar.
FORM: An authentic two-pane AIM client, chosen over a three-pane consensus console; consensus appears as room status inside the chat rather than as dashboard chrome.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { isNearBottom } from '$lib/chat-ui';
  import { CHAT_VOICES, personalityFor, personalityIds, screenNames, type PersonalityId } from '$lib/identity';
  import { connectOpenRouter, connectedKey, disconnectOpenRouter, finishOpenRouterConnection } from '$lib/openrouter-auth';

  type Model = { id: string; name: string; pricing: { input: number | null; output: number | null } };
  type Event = { type: string; [key: string]: any };
  type Seat = { id: string; modelId: string; alias: string; personalityId: PersonalityId };

  let question = $state('');
  let models = $state.raw<Model[]>([]);
  let selected = $state<Seat[]>([]);
  let participantCount = $state(3);
  let debateTurns = $state(3);
  let research = $state(false);
  let mode = $state<'consensus' | 'vote'>('consensus');
  let search = $state('');
  let sort = $state<'name-asc' | 'name-desc' | 'price-asc' | 'price-desc'>('name-asc');
  let events = $state<Event[]>([]);
  let running = $state(false);
  let error = $state('');
  let saved = $state('');
  let humanMessage = $state('');
  let sendingHuman = $state(false);
  let transcriptElement = $state<HTMLElement>();
  let followLatest = true;
  let connected = $state(false);
  let connecting = $state(false);

  let roster = $derived.by(() => {
    const tokens = search.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const filtered = models.filter((model) => {
      const searchable = `${model.name} ${model.id}`.toLowerCase();
      return tokens.every((token) => searchable.includes(token));
    });
    return filtered.toSorted((a, b) => {
      const direction = sort.endsWith('desc') ? -1 : 1;
      if (sort.startsWith('price')) {
        const aPrice = a.pricing.input === null || a.pricing.output === null ? null : a.pricing.input + a.pricing.output;
        const bPrice = b.pricing.input === null || b.pricing.output === null ? null : b.pricing.input + b.pricing.output;
        if (aPrice === null || bPrice === null) return aPrice === bPrice ? a.name.localeCompare(b.name) : aPrice === null ? 1 : -1;
        const priceDifference = aPrice - bPrice;
        if (priceDifference) return direction * priceDifference;
      }
      return sort.startsWith('name') ? direction * a.name.localeCompare(b.name) : a.name.localeCompare(b.name);
    });
  });
  let selectedModels = $derived(selected.map((seat) => models.find((model) => model.id === seat.modelId)).filter((model): model is Model => Boolean(model)));
  let participantNames = $derived(selected.map((seat) => seat.alias));
  let final = $derived(events.find((event) => event.type === 'final'));
  let run = $derived(events.find((event) => event.type === 'run'));
  let messages = $derived(events.filter((event) => event.type === 'message'));
  let modelMessages = $derived(messages.filter((event) => event.participant !== 'human'));
  let interpretationEvents = $derived(events.filter((event) => event.type === 'interpretation'));
  let offlineParticipants = $derived(new Set(events.filter((event) => event.type === 'error' && event.offline).map((event) => event.participant)));
  let activities = $derived.by(() => {
    if (!running) return [];
    const current: Record<string, Event> = {};
    for (const event of events) {
      if (event.type === 'activity' && (Number.isInteger(event.participant) || event.participant === 'room')) {
        if (event.status === 'done' || event.status === 'failed' || event.status === 'complete') delete current[String(event.participant)];
        else current[event.participant] = event;
      }
      if (event.type === 'message') delete current[String(event.participant)];
      if (event.type === 'interpretation') delete current.room;
    }
    return Object.values(current);
  });
  let cost = $derived(final?.cost ?? [...modelMessages, ...interpretationEvents].reduce((sum, event) => sum + Number(event.usage?.cost ?? 0), 0));
  let maxCalls = $derived((participantCount + 1) * (1 + debateTurns + (mode === 'vote' ? 1 : 0)));
  let calls = $derived(final?.calls ?? modelMessages.length + interpretationEvents.length);
  let ready = $derived(Boolean(question.trim()) && selected.length === participantCount && selectedModels.length === participantCount);
  let lastMessage = $derived(messages.at(-1));

  async function loadModels() {
    try {
      const storedKey = connectedKey();
      const response = await fetch('/api/models', { headers: storedKey ? { 'x-openrouter-key': storedKey } : {} });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      models = data.models;
      if (!selected.length) fillRoster(participantCount);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Could not load the OpenRouter agent list. Try refreshing the window.';
    }
  }

  onMount(async () => {
    try { connected = await finishOpenRouterConnection() || Boolean(connectedKey()); } catch (reason) { error = reason instanceof Error ? reason.message : 'OpenRouter connection failed.'; }
    await loadModels();
  });

  async function connect() {
    connecting = true;
    try { await connectOpenRouter(); } finally { connecting = false; }
  }

  function nextPersonality(used: Set<PersonalityId>) {
    return personalityIds(CHAT_VOICES.length).find((id) => !used.has(id));
  }

  function fillRoster(count: number) {
    const next = selected.slice(0, count);
    const names = new Set(next.map((seat) => seat.alias));
    const personalities = new Set(next.map((seat) => seat.personalityId));
    while (next.length < count && models[next.length]) {
      const alias = screenNames(100).find((name) => !names.has(name));
      const personalityId = nextPersonality(personalities);
      if (!alias || !personalityId) break;
      next.push({ id: crypto.randomUUID(), modelId: models[next.length].id, alias, personalityId });
      names.add(alias);
      personalities.add(personalityId);
    }
    selected = next;
  }

  function setParticipantCount(value: number) {
    participantCount = Math.max(2, Math.min(5, Math.round(value)));
    fillRoster(participantCount);
  }

  function setDebateTurns(value: number) {
    debateTurns = Math.max(1, Math.min(12, Math.round(value)));
  }

  function add(modelId: string) {
    if (selected.length >= participantCount) return;
    const usedNames = new Set(selected.map((seat) => seat.alias));
    const alias = screenNames(100).find((name) => !usedNames.has(name));
    const personalityId = nextPersonality(new Set(selected.map((seat) => seat.personalityId)));
    if (alias && personalityId) selected = [...selected, { id: crypto.randomUUID(), modelId, alias, personalityId }];
  }

  function remove(id: string) {
    selected = selected.filter((seat) => seat.id !== id);
  }

  function rerollPersonalities() {
    const fresh = personalityIds(selected.length);
    selected = selected.map((seat, index) => ({ ...seat, personalityId: fresh[index] }));
  }

  function rerollPersonality(id: string) {
    const used = new Set(selected.map((seat) => seat.personalityId));
    const personalityId = nextPersonality(used);
    if (personalityId) selected = selected.map((seat) => seat.id === id ? { ...seat, personalityId } : seat);
  }

  function money(value: number | null) {
    if (value === null) return 'varies';
    return value === 0 ? 'free' : `$${value < 0.01 ? value.toPrecision(3) : value.toFixed(2)}/M`;
  }

  function participantName(participant: number) {
    return (run?.screen_names?.[participant] ?? participantNames[participant] ?? `agent${participant + 1}`).toLowerCase();
  }

  function participantModel(participant: number) {
    return messages.toReversed().find((event) => event.participant === participant && event.model)?.model_name ?? selectedModels[participant]?.name;
  }

  async function handleEvent(event: Event) {
    const shouldFollow = followLatest;
    events = [...events, event];
    if (event.type === 'saved') saved = event.filename;
    if (event.type === 'error' && !event.recovered && !event.offline) error = event.error ?? 'The room stopped unexpectedly. Start a new chat to try again.';
    await tick();
    if (shouldFollow && transcriptElement) transcriptElement.scrollTop = transcriptElement.scrollHeight;
  }

  function transcriptScrolled() {
    if (transcriptElement) followLatest = isNearBottom(transcriptElement);
  }

  async function start() {
    if (!ready || running) return;
    running = true;
    error = '';
    saved = '';
    events = [];
    followLatest = true;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(connectedKey() ? { 'x-openrouter-key': connectedKey() } : {}) },
        body: JSON.stringify({ question, models: selected.map((seat) => seat.modelId), screenNames: participantNames, personalityIds: selected.map((seat) => seat.personalityId), participantCount, debateTurns, research, mode })
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('The room opened without a transcript stream. Start a new chat to try again.');
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) await handleEvent(JSON.parse(line));
      }
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'The chat could not start. Check the room settings and try again.';
    } finally {
      running = false;
    }
  }

  async function sendHuman(event: SubmitEvent) {
    event.preventDefault();
    const message = humanMessage.trim();
    if (!message || !running || !run?.run_id || sendingHuman) return;
    sendingHuman = true;
    try {
      const response = await fetch(`/api/chat/${run.run_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      humanMessage = '';
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Your message was not sent. Try again while the room is active.';
    } finally {
      sendingHuman = false;
    }
  }

  function composerKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }

  function newChat() {
    rerollPersonalities();
    events = [];
    saved = '';
    error = '';
    question = '';
    humanMessage = '';
    followLatest = true;
  }
</script>

<svelte:head>
  <title>Agent Inquiry Messenger</title>
  <meta name="description" content="An AIM-style group chat where AI agents talk through a question and try to agree." />
</svelte:head>

{#snippet titlebar(title: string)}
  <header class="titlebar">
    <span class="aim-mark" aria-hidden="true">A</span>
    <strong>{title}</strong>
    <span class="window-buttons" aria-hidden="true"><span>_</span><span>□</span><span>×</span></span>
  </header>
{/snippet}

{#snippet menubar()}
  <div class="menubar" aria-hidden="true"><span>File</span><span>Edit</span><span>People</span><span>Help</span></div>
{/snippet}

{#if !run}
  <main class="desktop setup-desktop">
    <section class="window setup-window" aria-labelledby="setup-title">
      {@render titlebar('Agent Inquiry Messenger')}
      {@render menubar()}

      <div class="setup-heading">
        <div class="logo-lockup" aria-hidden="true"><span class="running-man">AIM</span></div>
        <div>
          <p class="kicker">Welcome</p>
          <h1 id="setup-title">Start a group chat</h1>
          <p>Ask one question, invite a few AI agents, and watch them talk it through.</p>
          <p class="auth-copy">{connected ? 'OpenRouter connected — your key stays in this browser session.' : 'Guest access includes free agents. Connect OpenRouter to unlock the full model catalog and use your own credits.'}</p>
          {#if connected}<button type="button" class="auth-button" onclick={() => { disconnectOpenRouter(); connected = false; selected = []; loadModels(); }}>Use guest access</button>{:else}<button type="button" class="auth-button" onclick={connect} disabled={connecting}>{connecting ? 'Connecting…' : 'Connect OpenRouter'}</button>{/if}
        </div>
      </div>

      <div class="setup-workspace">
        <section class="room-builder" aria-labelledby="room-builder-title">
          <div class="pane-heading"><h2 id="room-builder-title">Room setup</h2><span>{ready ? 'Ready to sign on' : 'Complete the room details'}</span></div>

          <label class="field-label" for="question">Question for the room</label>
          <textarea id="question" bind:value={question} rows="4" placeholder="What’s the best harmless superpower for everyday life?"></textarea>

          <section class="selected-panel" aria-labelledby="selected-title" aria-live="polite">
            <div class="selected-heading"><h3 id="selected-title">Agents in this room</h3><span>{selected.length} of {participantCount}</span></div>
            {#if selected.length}
              <div class="selected-list">
                {#each selected as seat, index (seat.id)}
                  {@const model = models.find((item) => item.id === seat.modelId)}
                  {@const personality = personalityFor(seat.personalityId)}
                  <div class="selected-person"><span class="status-dot">●</span><b title={participantName(index)}>{participantName(index)}</b><span class="selected-personality" title={personality.label}>{personality.label}</span><span title={model?.name ?? seat.modelId}>{model?.name ?? 'loading…'}</span><span class="selected-actions"><button type="button" onclick={() => rerollPersonality(seat.id)} aria-label={`Re-roll ${participantName(index)}'s personality`}>Re-roll</button><button type="button" onclick={() => remove(seat.id)} aria-label={`Remove ${participantName(index)}`}>Remove</button></span></div>
                {/each}
              </div>
            {:else}
              <div class="empty-state"><span class="offline-dot">●</span><p>Assigning agents…<small>Loading the OpenRouter catalog.</small></p></div>
            {/if}
          </section>

          {#if error}<p class="alert" role="alert"><b>The room hit a snag.</b><span>{error}</span></p>{/if}
        </section>

        <details class="room-settings">
          <summary>Change room settings</summary>
          <div class="room-settings-content">
            <div class="setup-controls">
              <fieldset class="mode-picker">
                <legend>How should the room finish?</legend>
                <label class:active={mode === 'consensus'}><input type="radio" name="mode" value="consensus" bind:group={mode} /><span><b>Reach an agreement</b><small>Stop when every agent lands on the same answer</small></span></label>
                <label class:active={mode === 'vote'}><input type="radio" name="mode" value="vote" bind:group={mode} /><span><b>Take a vote</b><small>Finish the chat, then choose the answer with the most votes</small></span></label>
              </fieldset>
              <fieldset>
                <legend>Number of agents</legend>
                <div class="count-picker">
                  {#each [2, 3, 4, 5] as count (count)}
                    <button type="button" class:active={participantCount === count} aria-pressed={participantCount === count} onclick={() => setParticipantCount(count)}>{count}</button>
                  {/each}
                </div>
              </fieldset>
              <label class="turn-field" for="turns"><span>Rounds after opening</span><input id="turns" type="number" min="1" max="12" value={debateTurns} oninput={(event) => setDebateTurns(Number(event.currentTarget.value))} /><small>Up to {maxCalls} AI requests</small></label>
            </div>

            <button type="button" class="research-toggle" class:enabled={research} aria-pressed={research} onclick={() => research = !research}>
              <span class="checkbox" aria-hidden="true">{research ? '✓' : ''}</span>
              <span><b>Let agents search the web</b><small>{research ? 'On — agents can use current sources' : 'Off — agents answer from what they know'}</small></span>
            </button>

            <section class="directory" aria-labelledby="directory-title">
              <div class="pane-heading"><h2 id="directory-title">Choose agents</h2><span>{connected ? `${roster.length} available` : `${roster.length} free available`}</span></div>
              <div class="directory-tools">
                <label class="search-field" for="search"><span>Find an agent</span><input id="search" bind:value={search} type="search" placeholder="Search models or providers…" /></label>
                <label class="sort-field" for="sort"><span>Sort by</span><select id="sort" bind:value={sort}><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="price-asc">Price low–high</option><option value="price-desc">Price high–low</option></select></label>
              </div>
              <div class="roster" aria-label="OpenRouter agent list">
                {#if !models.length}<div class="directory-state"><span class="status-dot">●</span>Connecting to OpenRouter…</div>{/if}
                {#if models.length && !roster.length}<div class="directory-state">No agents match “{search}”.</div>{/if}
                {#each roster as model (model.id)}
                  {@const selectedCount = selected.filter((seat) => seat.modelId === model.id).length}
                  <button type="button" class="buddy-row" class:selected={selectedCount > 0} disabled={selected.length >= participantCount} onclick={() => add(model.id)} aria-label={selectedCount ? `Add another ${model.name}` : `Add ${model.name}`}>
                    <span class="status-dot">●</span>
                    <span class="model-copy"><b>{model.name}</b><small>{model.id}</small></span>
                    <span class="pricing"><span>read {money(model.pricing.input)}</span><span>reply {money(model.pricing.output)}</span></span>
                    <span class="invite-state">{selectedCount ? selected.length < participantCount ? `Add another (${selectedCount})` : `${selectedCount} added` : 'Add'}</span>
                  </button>
                {/each}
              </div>
            </section>
          </div>
        </details>
      </div>

      <footer class="setup-footer">
        <div class="footer-status"><span class:online={ready} class="footer-dot">●</span><span>{ready ? `${participantCount} agents ready · ${mode === 'vote' ? 'Take a vote' : 'Reach an agreement'} · Web search ${research ? 'on' : 'off'} · Up to ${maxCalls} AI requests` : selected.length < participantCount ? `Invite ${participantCount - selected.length} more ${participantCount - selected.length === 1 ? 'agent' : 'agents'}` : 'Enter a question to continue'}</span></div>
        <button class="primary-button" disabled={!ready || running} onclick={start}>{running ? 'Signing on…' : 'Start room'}</button>
      </footer>
    </section>
  </main>
{:else}
  <main class="desktop chat-desktop">
    <section class="window chat-window" aria-labelledby="chat-title">
      {@render titlebar(`Agent Inquiry Messenger — ${selected.length} agents`)}
      {@render menubar()}

      <section class="room-banner" aria-labelledby="chat-title">
        <div><span class="room-label">Room topic</span><h1 id="chat-title">{run.question}</h1></div>
        <div class="room-state"><span class:online={running} class="footer-dot">●</span><b>{running ? 'Online' : 'Room closed'}</b></div>
      </section>

      <div class="chat-layout">
        <aside class="participants" aria-labelledby="buddy-list-title">
          <div class="pane-heading"><h2 id="buddy-list-title">Agent list</h2><span>{running ? 'Online' : 'Room closed'}</span></div>
          <div class="participant-list">
            {#each selected as seat, index (seat.id)}
              {@const activity = activities.find((item) => item.participant === index)}
              <div class="participant" class:working={Boolean(activity)} class:offline={!running || offlineParticipants.has(index)}><span class="status-dot">●</span><span><b>{participantName(index)}</b><small class="participant-personality">{personalityFor(seat.personalityId).label}</small><small class="participant-model" title={activity?.model_name ?? participantModel(index)}>{activity?.model_name ?? participantModel(index)}</small><small class="participant-status">{activity?.status === 'rate_limit' ? 'waiting…' : activity ? 'typing…' : !running || offlineParticipants.has(index) ? 'offline' : 'online'}</small></span></div>
            {/each}
            <div class="participant you" class:offline={!running}><span class="status-dot">●</span><span><b>You</b><small>{running ? 'online' : 'offline'}</small></span></div>
          </div>
          <details class="room-info">
            <summary>Room details</summary>
            <dl class="room-stats">
              <div><dt>AI requests</dt><dd>{calls} / {run.max_calls}</dd></div>
              <meter min="0" max={run.max_calls} value={calls}>{calls} of {run.max_calls}</meter>
              <div><dt>Cost so far</dt><dd>${Number(cost).toFixed(4)}</dd></div>
              <div><dt>How it ends</dt><dd>{run.mode === 'vote' ? 'Take a vote' : 'Reach an agreement'}</dd></div>
              <div><dt>Web search</dt><dd>{run.research ? 'On' : 'Off'}</dd></div>
            </dl>
            <ul>{#each selected as seat, index (seat.id)}{@const model = models.find((item) => item.id === seat.modelId)}<li><b>{participantName(index)}</b><span>{personalityFor(seat.personalityId).label} · {model?.name ?? seat.modelId}</span></li>{/each}</ul>
          </details>
        </aside>

        <p class="sr-only" aria-live="polite">{lastMessage ? `${lastMessage.participant === 'human' ? 'You' : `Agent ${participantName(lastMessage.participant)}`}: ${lastMessage.message}` : activities.length ? 'Agents are preparing a response.' : ''}</p>
        <section class="transcript" aria-label="Chat transcript" bind:this={transcriptElement} onscroll={transcriptScrolled}>
          <div class="system-messages" aria-hidden="true">
            {#each selected as seat, index (seat.id)}<p>*** {participantName(index)} has entered the room.</p>{/each}
          </div>
          {#if activities.length}
            <div class="activity-list">
              {#each activities as activity (activity.model + activity.participant)}<p><b>{activity.screen_name}</b> {activity.message}</p>{/each}
            </div>
          {/if}

          {#each messages as event, index (`${event.created_at ?? event.rotation}-${event.participant}-${index}`)}
            <article class="message" class:human={event.participant === 'human'}>
              <header><b>{event.participant === 'human' ? 'You' : event.screen_name ?? participantName(event.participant)}</b></header>
              <p>{event.message}</p>

            </article>
          {/each}

          {#if final}
            <article class="message observer"><header><b>{final.observer}</b><small>room referee</small></header><p>{final.outcome}</p></article>
            <p class="system-notice">*** the room closed</p>
          {/if}
          {#if error}<p class="alert" role="alert"><b>Room notice</b><span>{error}</span></p>{/if}
        </section>
      </div>

      <form class="composer" onsubmit={sendHuman}>
        <label for="human-message"><span>Send to</span><b>Group Chat</b></label>
        <textarea id="human-message" bind:value={humanMessage} rows="2" maxlength="500" placeholder={running ? 'Write a message…' : 'This room is closed'} disabled={!running} onkeydown={composerKeydown}></textarea>
        <div class="composer-actions"><small>Enter to send · Shift+Enter for a new line</small><button type="submit" disabled={!running || !humanMessage.trim() || sendingHuman}>{sendingHuman ? 'Sending…' : 'Send'}</button></div>
      </form>

      <footer class="chat-footer">
        <span><span class:online={running} class="footer-dot">●</span>{running ? 'Connected to room' : saved ? `Transcript saved · ${saved}` : 'Conversation complete'}</span>
        <button disabled={running} onclick={newChat}>New room</button>
      </footer>
    </section>
  </main>
{/if}

<style>
  :global(*) { box-sizing: border-box; }
  :global(:root) {
    --desktop-blue: #5f7fa8;
    --title-blue: #073b82;
    --title-blue-light: #3269a9;
    --aim-yellow: #ffd324;
    --chrome: #d7d5c9;
    --chrome-light: #f2f1e8;
    --chrome-dark: #85857f;
    --pane: #ffffff;
    --pane-inset: #f7f7f2;
    --ink: #161616;
    --ink-secondary: #4e4e4a;
    --ink-tertiary: #6b6b66;
    --ink-muted: #8a8a84;
    --link-blue: #003399;
    --screen-red: #a00000;
    --online-green: #2d9a24;
    --proposal-amber: #8b6100;
    --proposal-paper: #fff6c8;
    --support-green: #26751f;
    --support-paper: #e1f3dc;
    --danger-red: #8a2020;
    --danger-paper: #f8dddd;
    --focus-blue: #001f72;
  }
  :global(body) { margin: 0; color: var(--ink); background: var(--desktop-blue); font: 13px/1.35 Tahoma, Verdana, sans-serif; }
  button, input, select, textarea { font: inherit; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px dotted var(--focus-blue); outline-offset: 2px; }
  button:disabled, input:disabled, textarea:disabled { color: var(--ink-muted); cursor: not-allowed; }

  .desktop { min-height: 100vh; display: grid; place-items: center; padding: 16px; overflow: hidden; }
  .window { background: var(--chrome); border: 2px solid #fff; border-right-color: #2e2e2b; border-bottom-color: #2e2e2b; box-shadow: 3px 3px 0 #2c405d; }
  .titlebar { min-height: 28px; display: flex; align-items: center; gap: 7px; padding: 3px 5px; color: #fff; background: linear-gradient(90deg, var(--title-blue), var(--title-blue-light)); }
  .titlebar strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .aim-mark { width: 17px; height: 17px; display: grid; place-items: center; flex: 0 0 auto; color: #143b00; background: var(--aim-yellow); border: 1px outset #fff; font-size: 10px; font-weight: 900; }
  .window-buttons { margin-left: auto; display: flex; gap: 3px; }
  .window-buttons span { width: 17px; height: 17px; display: grid; place-items: center; color: var(--ink); background: var(--chrome); border: 1px outset #fff; font-weight: 700; line-height: 1; }
  .menubar { height: 25px; display: flex; align-items: center; gap: 2px; padding: 1px 5px; border-bottom: 1px solid var(--chrome-dark); background: var(--chrome-light); }
  .menubar span { padding: 2px 7px; color: var(--ink); }
  .menubar span:first-letter { text-decoration: underline; }
  .pane-heading { min-height: 31px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 7px; border-bottom: 1px solid #b7b6ae; }
  .pane-heading h2 { margin: 0; color: var(--title-blue); font-size: 13px; letter-spacing: .01em; text-transform: uppercase; }
  .pane-heading span { color: var(--ink-tertiary); font-size: 10px; }
  .status-dot { color: var(--online-green); }
  .offline-dot { color: var(--ink-muted); }
  .footer-dot { color: var(--ink-muted); }
  .footer-dot.online { color: var(--online-green); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

  .setup-window { width: min(1040px, calc(100vw - 32px)); height: min(760px, calc(100vh - 32px)); min-height: 600px; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto; }
  .setup-heading { display: flex; align-items: center; gap: 15px; padding: 14px 18px; border-bottom: 1px solid #aaa9a1; background: var(--chrome-light); }
  .logo-lockup { width: 58px; height: 48px; display: grid; place-items: center; flex: 0 0 auto; color: var(--title-blue); background: var(--aim-yellow); border: 2px outset #fff; }
  .running-man { font-weight: 900; letter-spacing: .08em; }
  .kicker { margin: 0 0 2px; color: var(--screen-red); font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .setup-heading h1 { margin: 0; color: var(--title-blue); font-size: 22px; line-height: 1.1; }
  .setup-heading p:last-child { margin: 4px 0 0; color: var(--ink-secondary); }
  .auth-copy { font-size: 11px; }
  .auth-button:disabled { color: var(--ink-muted); background: var(--chrome); }
  .auth-button { margin-top: 5px; padding: 4px 8px; color: #fff; background: var(--title-blue); border: 2px outset #fff; font-size: 11px; font-weight: 700; cursor: pointer; }
  .setup-workspace { min-height: 0; display: grid; grid-template-rows: auto auto; align-content: start; gap: 8px; padding: 8px; overflow: auto; }
  .room-builder, .room-settings { min-height: 0; padding: 12px; border: 2px inset #fff; background: var(--chrome-light); }
  .room-builder { overflow: auto; }
  .room-settings { overflow: auto; }
  .room-settings[open] { display: grid; grid-template-rows: auto minmax(0, 1fr); }
  .room-settings summary { color: var(--title-blue); font-weight: 700; cursor: pointer; }
  .room-settings-content { min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 10px; margin-top: 10px; }
  .directory { min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); padding: 10px; border: 1px solid #aaa9a1; background: var(--chrome-light); }
  .field-label, .search-field > span, .sort-field > span, .turn-field > span { display: block; margin: 13px 0 5px; font-weight: 700; }
  textarea, input { width: 100%; color: var(--ink); background: var(--pane-inset); border: 2px inset #fff; padding: 7px 8px; }
  textarea::placeholder, input::placeholder { color: var(--ink-tertiary); opacity: 1; }
  textarea { resize: vertical; }
  .setup-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
  .mode-picker { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .mode-picker label { display: flex; align-items: flex-start; gap: 7px; padding: 7px; background: var(--chrome); border: 1px outset #fff; cursor: pointer; }
  .mode-picker label.active { background: #e3ecf8; border-style: inset; }
  .mode-picker input { width: auto; margin: 2px 0 0; }
  .mode-picker label span { display: grid; gap: 2px; }
  .mode-picker small { color: var(--ink-secondary); }
  fieldset { min-width: 0; margin: 0; padding: 7px 8px 8px; border: 1px solid #aaa9a1; }
  legend { padding: 0 4px; font-weight: 700; }
  .count-picker { display: grid; grid-template-columns: repeat(4, 1fr); }
  .count-picker button { min-height: 31px; border: 1px outset #fff; background: var(--chrome); cursor: pointer; }
  .count-picker button.active { color: #fff; background: var(--title-blue); border-style: inset; }
  .turn-field { display: grid; grid-template-columns: 1fr 70px; align-items: center; gap: 4px 8px; }
  .turn-field > span { margin: 0; }
  .turn-field input { padding: 5px 7px; }
  .turn-field small { grid-column: 1 / -1; color: var(--ink-tertiary); }
  .research-toggle { width: 100%; display: flex; align-items: center; gap: 8px; margin: 12px 0; padding: 8px; color: var(--ink); background: var(--chrome); border: 2px outset #fff; text-align: left; cursor: pointer; }
  .research-toggle.enabled { background: #e5f0df; }
  .research-toggle > span:last-child { display: grid; gap: 1px; }
  .research-toggle small { color: var(--ink-secondary); }
  .checkbox { width: 18px; height: 18px; display: grid; place-items: center; flex: 0 0 auto; color: var(--support-green); background: var(--pane); border: 2px inset #fff; font-weight: 900; }
  .selected-panel { border: 1px solid #aaa9a1; background: var(--pane); }
  .selected-heading { display: flex; justify-content: space-between; gap: 8px; padding: 7px 8px; background: var(--chrome); border-bottom: 1px solid #aaa9a1; }
  .selected-heading h3 { margin: 0; font-size: 12px; }
  .selected-heading span { color: var(--ink-secondary); font-size: 10px; }
  .selected-list { max-height: 210px; overflow: auto; }
  .selected-person { min-height: 34px; display: grid; grid-template-columns: auto minmax(0, .8fr) minmax(0, .7fr) minmax(0, 1fr) auto; align-items: center; gap: 5px; padding: 5px 7px; border-bottom: 1px dotted #aaa9a1; }
  .selected-person b, .selected-person > span:not(.status-dot) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .selected-person button { padding: 2px 6px; color: var(--link-blue); background: transparent; border: 0; text-decoration: underline; cursor: pointer; }
  .selected-actions { display: flex; }
  .empty-state { min-height: 72px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; color: var(--ink-secondary); }
  .empty-state p, .empty-state small { display: grid; margin: 0; }
  .empty-state small { color: var(--ink-tertiary); }
  .directory-tools { display: grid; grid-template-columns: minmax(0, 1fr) 142px; gap: 8px; margin-bottom: 8px; }
  .search-field, .sort-field { display: block; min-width: 0; }
  .search-field > span, .sort-field > span { margin-top: 10px; }
  .sort-field select { width: 100%; min-height: 35px; padding: 6px; color: var(--ink); background: var(--pane-inset); border: 2px inset #fff; }
  .roster { min-height: 0; overflow: auto; border: 2px inset #fff; background: var(--pane); }
  .buddy-row { width: 100%; min-height: 48px; display: grid; grid-template-columns: auto minmax(0, 1fr) 100px 34px; align-items: center; gap: 8px; padding: 6px 8px; color: var(--ink); background: transparent; border: 0; border-bottom: 1px solid #d8d8d2; text-align: left; cursor: pointer; }
  .buddy-row:hover { background: #e3ecf8; }
  .buddy-row.selected { background: #c9dbf2; }
  .model-copy { min-width: 0; display: grid; gap: 2px; }
  .model-copy b, .model-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model-copy small { color: var(--ink-secondary); font-size: 10px; }
  .pricing { display: grid; color: var(--ink-secondary); font: 10px/1.35 "Courier New", monospace; text-align: right; }
  .invite-state { color: var(--link-blue); font-size: 10px; font-weight: 700; text-align: right; }
  .directory-state { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 80px; color: var(--ink-secondary); }
  .setup-footer, .chat-footer { min-height: 50px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 10px; border-top: 2px groove #fff; background: var(--chrome-light); }
  .footer-status { min-width: 0; display: flex; align-items: center; gap: 6px; color: var(--ink-secondary); }
  .footer-status span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .primary-button, .chat-footer button, .composer button { min-width: 104px; padding: 7px 14px; color: var(--ink); background: var(--chrome); border: 2px outset #fff; font-weight: 700; cursor: pointer; }
  .primary-button:not(:disabled) { color: #fff; background: var(--title-blue); }
  .primary-button:active, .chat-footer button:active, .composer button:active { border-style: inset; }

  .chat-window { width: min(1120px, calc(100vw - 32px)); height: min(820px, calc(100vh - 32px)); min-height: 610px; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto auto; }
  .room-banner { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 9px 12px; border-bottom: 1px solid #aaa9a1; background: var(--chrome-light); }
  .room-label { color: var(--ink-tertiary); font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .room-banner h1 { max-width: 72ch; margin: 2px 0 0; color: var(--ink); font-size: 15px; line-height: 1.25; }
  .room-state { display: flex; align-items: center; gap: 5px; color: var(--ink-secondary); white-space: nowrap; }
  .chat-layout { min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr); overflow: hidden; }
  .participants { min-height: 0; display: flex; flex-direction: column; padding: 10px; overflow: auto; border-right: 1px solid #9d9d97; background: var(--chrome-light); }
  .participant-list { margin-top: 6px; }
  .participant { min-height: 55px; display: flex; align-items: flex-start; gap: 7px; padding: 7px 3px; border-bottom: 1px dotted #aaa9a1; }
  .participant > span:last-child { min-width: 0; display: grid; }
  .participant b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--link-blue); font-size: 11px; }
  .participant small { margin-top: 2px; overflow: hidden; color: var(--ink-tertiary); text-overflow: ellipsis; white-space: nowrap; }
  .participant-personality { color: var(--screen-red) !important; font-size: 10px; }
  .participant-model { font-size: 10px; }
  .participant.you b { color: var(--screen-red); }
  .participant.offline .status-dot { color: var(--ink-muted); }
  .participant.working .participant-status { color: var(--support-green); font-weight: 700; }
  .room-info { margin-top: auto; padding-top: 10px; border-top: 1px solid #aaa9a1; color: var(--ink-secondary); }
  .room-info summary { color: var(--link-blue); cursor: pointer; font-weight: 700; }
  .room-info ul { margin: 8px 0 0; padding: 0; list-style: none; }
  .room-info li { display: grid; gap: 1px; margin-top: 6px; }
  .room-info li span { overflow: hidden; color: var(--ink-tertiary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .room-stats { margin: 7px 0 0; }
  .room-stats div { display: flex; justify-content: space-between; gap: 8px; margin: 5px 0; }
  .room-stats dt { color: var(--ink-secondary); }
  .room-stats dd { margin: 0; font: 11px "Courier New", monospace; font-weight: 700; }
  .room-stats meter { width: 100%; height: 13px; }
  .transcript { min-height: 0; overflow: auto; padding: 12px 14px 24px; background: var(--pane); scroll-behavior: smooth; }
  .system-messages { margin-bottom: 10px; color: var(--ink-tertiary); font-size: 10px; }
  .system-messages p { margin: 2px 0; }
  .activity-list { margin-bottom: 11px; padding: 7px 9px; color: var(--ink-secondary); background: var(--pane-inset); border: 1px dotted #969690; }
  .activity-list p { margin: 3px 0; }
  .activity-list b { color: var(--link-blue); }
  .message { padding: 5px 4px 9px; border-bottom: 1px solid #e1e1dc; }
  .message + .message { margin-top: 4px; }
  .message header { display: flex; align-items: baseline; }
  .message header b { color: var(--link-blue); font-size: 11px; }
  .message header small { margin-left: 6px; color: var(--ink-tertiary); }
  .message.observer { margin-top: 10px; background: var(--pulse-yellow); border: 1px solid #d2c269; }
  .message.human header b { color: var(--screen-red); }
  .message > p { max-width: 72ch; margin: 3px 0 5px; line-height: 1.5; white-space: pre-wrap; }
  .system-notice { margin: 12px 4px 2px; color: var(--ink-tertiary); font-size: 11px; }
  .alert { display: grid; gap: 2px; margin: 10px 0 0; padding: 8px; color: var(--danger-red); background: var(--danger-paper); border: 1px solid #b76464; }
  .alert b { font-size: 11px; }
  .composer { display: grid; grid-template-columns: 118px minmax(0, 1fr) 170px; align-items: stretch; gap: 8px; padding: 8px 10px; border-top: 2px groove #fff; background: var(--chrome-light); }
  .composer label { align-self: center; display: grid; color: var(--ink-secondary); font-size: 10px; }
  .composer label b { margin-top: 2px; color: var(--link-blue); font-size: 11px; }
  .composer textarea { min-height: 48px; resize: none; }
  .composer-actions { display: flex; flex-direction: column; align-items: stretch; justify-content: space-between; gap: 4px; }
  .composer-actions small { color: var(--ink-tertiary); font-size: 9px; }
  .composer-actions button { width: 100%; min-width: 0; }
  .chat-footer { min-height: 38px; padding-top: 4px; padding-bottom: 4px; color: var(--ink-secondary); font-size: 10px; }
  .chat-footer > span { min-width: 0; display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-footer button { min-width: 84px; padding: 4px 10px; font-size: 10px; }

  @media (max-width: 760px) {
    .desktop { min-height: 100dvh; display: block; padding: 6px; overflow: visible; }
    .setup-window { width: 100%; height: auto; min-height: calc(100dvh - 12px); }
    .chat-window { width: 100%; height: calc(100dvh - 12px); min-height: 0; }
    .setup-heading { padding: 10px 12px; }
    .setup-heading h1 { font-size: 18px; }
    .logo-lockup { width: 48px; height: 40px; }
    .setup-workspace { display: block; overflow: visible; }
    .room-builder { overflow: visible; }
    .directory { display: block; margin-top: 8px; }
    .roster { max-height: 420px; }
    .setup-controls { grid-template-columns: 1fr; }
    .mode-picker { grid-column: auto; }
    .setup-footer { position: static; }
    .footer-status { font-size: 10px; }
    .chat-window { grid-template-rows: auto auto auto minmax(0, 1fr) auto auto; }
    .room-banner { align-items: flex-start; }
    .room-banner h1 { font-size: 13px; }
    .room-state { font-size: 10px; }
    .chat-layout { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
    .participants { display: block; padding: 6px 8px; overflow: auto hidden; border-right: 0; border-bottom: 1px solid #9d9d97; }
    .participants .pane-heading, .room-info { display: none; }
    .participant-list { display: flex; gap: 8px; margin: 0; }
    .participant { min-width: 145px; min-height: 37px; padding: 4px 2px; border-bottom: 0; }
    .composer { grid-template-columns: 1fr 104px; }
    .composer label { grid-column: 1 / -1; display: flex; gap: 5px; }
    .composer-actions small { display: none; }
    .composer-actions { justify-content: flex-end; }
  }

  @media (max-width: 480px) {
    .setup-heading p:last-child, .room-state b, .composer label span { display: none; }
    .setup-workspace { padding: 4px; gap: 4px; }
    .room-builder, .directory { padding: 9px; }
    .mode-picker, .directory-tools { grid-template-columns: 1fr; }
    .setup-footer { gap: 8px; }
    .footer-status { flex: 1; }
    .primary-button { min-width: 112px; }
    .buddy-row { grid-template-columns: auto minmax(0, 1fr) 30px; }
    .pricing { display: none; }
    .composer { grid-template-columns: minmax(0, 1fr) 82px; gap: 5px; padding: 6px; }
    .chat-footer { min-height: 34px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .transcript { scroll-behavior: auto; }
  }
</style>
