export const SCREEN_NAME_POOL = [
  'xxbubblewrapxx', 'cheesewizard', 'aimnonymous', 'pixelpickle', 'floppydiskfox', 'dialupdoodle', 'neonnoodle', 'snackattack', 'ctrlaltdelight', 'glittergoblin',
  'modemmuffin', 'y2kyoyo', 'fuzzylogic', 'pajamapilot', 'turbotater', 'webcamwalrus', 'limewirellama', 'laserhamster', 'cybercupcake', 'moonboots',
  'frostedflake', 'bubbleteabard', 'sodapopstar', 'quirkasaurus', 'wafflepacket', 'bleepbloop', 'radicalradish', 'gigagumdrop', 'doodlebug', 'mysterymeat',
  'aolartiste', 'sporkninja', 'cosmicnacho', 'jellybeanjam', 'tinfoiltiara', 'toasterghost', 'vhsvoyager', 'pogopanda', 'cerealkiller', 'funkyfolder',
  'sillystring', 'mangomaverick', 'rubberduckie', 'glitchgiraffe', 'napsternapper', 'tacotornado', 'velvetvampire', 'puddingpunk', 'sk8rpenguin', 'bananabandwidth',
  'chatterbox', 'discodolphin', 'ramenranger', 'socksandsandals', 'bouncycastle', 'crayoncommander', 'wigglewizard', 'koolkat', 'funkyfresh', 'zanyzebra',
  'peppypancake', 'orbitingostrich', 'squeegeequeen', 'marshmallowmafia', 'nerdynugget', 'couchpotato', 'gummybearforce', 'snoozebutton', 'popcornpirate', 'plasmapopsicle',
  'quiltedquokka', 'jukeboxjester', 'mellowmeerkat', 'radishrascal', 'biscuitbandit', 'yoyoyeti', 'staticsquirrel', 'turtleturbine', 'fizzyfrog', 'chromechihuahua',
  'wackywombat', 'sundaedriver', 'karaokekoala', 'pineappleping', 'spookyspatula', 'dizzydaisy', 'cosmiccornflake', 'burritobard', 'noodlenerd', 'pepperonipixel',
  'hulahoophero', 'caffeinatedcat', 'roboravioli', 'sassysasquatch', 'ketchupkomet', 'muppetmeteor', 'cheddarchampion', 'whimsywhale', 'bloopblaster', 'fuzzyfajita'
] as const;

export const PERSONALITIES = [
  { id: 'terse', label: 'terse', prompt: 'You are terse and usually send a fragment rather than a polished sentence.' },
  { id: 'upbeat', label: 'upbeat', prompt: 'You are upbeat and occasionally use lol, haha, or an old-school text face like :) when it genuinely fits.' },
  { id: 'skeptical', label: 'skeptical', prompt: 'You are skeptical and direct, but friendly. You often ask a short question or point out one weak spot.' },
  { id: 'casual', label: 'casual', prompt: 'You type casually and sometimes leave in a harmless typo or missing apostrophe.' },
  { id: 'dry', label: 'dry', prompt: 'You are dry and understated. You rarely use slang and never sound like a judge or lecturer.' },
  { id: 'excitable', label: 'excitable', prompt: 'You are excitable and sometimes emphasize one word with extra punctuation.' }
] as const;

export const CHAT_VOICES = PERSONALITIES;
export type PersonalityId = typeof PERSONALITIES[number]['id'];
export type Personality = typeof PERSONALITIES[number];
export type ChatVoice = Personality;

export function validScreenNames(names: unknown, participantCount?: number): names is string[] {
  return Array.isArray(names) && (participantCount === undefined || names.length === participantCount) && new Set(names).size === names.length && names.every(name => typeof name === 'string' && SCREEN_NAME_POOL.includes(name as typeof SCREEN_NAME_POOL[number]));
}

export function screenNames(count: number): string[] {
  const pool = [...SCREEN_NAME_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function validPersonalityIds(value: unknown, participantCount?: number): value is PersonalityId[] {
  return Array.isArray(value) && (participantCount === undefined || value.length === participantCount) && new Set(value).size === value.length && value.every(id => typeof id === 'string' && PERSONALITIES.some(personality => personality.id === id));
}

export function personalityIds(count: number): PersonalityId[] {
  const pool = PERSONALITIES.map(personality => personality.id);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function defaultPersonalityIds(count: number): PersonalityId[] {
  return PERSONALITIES.slice(0, count).map(personality => personality.id);
}

export function personalityFor(id: PersonalityId): Personality {
  return PERSONALITIES.find(personality => personality.id === id)!;
}
