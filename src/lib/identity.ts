export const SCREEN_NAME_POOL = [
  'xXBubbleWrapXx', 'CheeseWizard', 'AIMnonymous', 'PixelPickle', 'FloppyDiskFox', 'DialupDoodle', 'NeonNoodle', 'SnackAttack', 'CtrlAltDelight', 'GlitterGoblin',
  'ModemMuffin', 'Y2KYoYo', 'FuzzyLogic', 'PajamaPilot', 'TurboTater', 'WebcamWalrus', 'LimewireLlama', 'LaserHamster', 'CyberCupcake', 'MoonBoots',
  'FrostedFlake', 'BubbleTeaBard', 'SodaPopStar', 'Quirkasaurus', 'WafflePacket', 'BleepBloop', 'RadicalRadish', 'GigaGumdrop', 'DoodleBug', 'MysteryMeat',
  'AOLArtiste', 'SporkNinja', 'CosmicNacho', 'JellyBeanJam', 'TinfoilTiara', 'ToasterGhost', 'VHSVoyager', 'PogoPanda', 'CerealKiller', 'FunkyFolder',
  'SillyString', 'MangoMaverick', 'RubberDuckie', 'GlitchGiraffe', 'NapsterNapper', 'TacoTornado', 'VelvetVampire', 'PuddingPunk', 'Sk8rPenguin', 'BananaBandwidth',
  'ChatterBox', 'DiscoDolphin', 'RamenRanger', 'SocksAndSandals', 'BouncyCastle', 'CrayonCommander', 'WiggleWizard', 'KoolKat', 'FunkyFresh', 'ZanyZebra',
  'PeppyPancake', 'OrbitingOstrich', 'SqueegeeQueen', 'MarshmallowMafia', 'NerdyNugget', 'CouchPotato', 'GummyBearForce', 'SnoozeButton', 'PopcornPirate', 'PlasmaPopsicle',
  'QuiltedQuokka', 'JukeboxJester', 'MellowMeerkat', 'RadishRascal', 'BiscuitBandit', 'YoYoYeti', 'StaticSquirrel', 'TurtleTurbine', 'FizzyFrog', 'ChromeChihuahua',
  'WackyWombat', 'SundaeDriver', 'KaraokeKoala', 'PineapplePing', 'SpookySpatula', 'DizzyDaisy', 'CosmicCornflake', 'BurritoBard', 'NoodleNerd', 'PepperoniPixel',
  'HulaHoopHero', 'CaffeinatedCat', 'RoboRavioli', 'SassySasquatch', 'KetchupKomet', 'MuppetMeteor', 'CheddarChampion', 'WhimsyWhale', 'BloopBlaster', 'FuzzyFajita'
] as const;

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
