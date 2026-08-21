const sessions = new Map<string, (message: string) => void>();

export function registerSession(id: string, receive: (message: string) => void) {
  sessions.set(id, receive);
  return () => sessions.delete(id);
}

export function sendToSession(id: string, message: string) {
  const receive = sessions.get(id);
  if (!receive) return false;
  receive(message);
  return true;
}
