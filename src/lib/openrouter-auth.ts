const STORAGE_KEY = 'aim.openrouter.api-key';

function base64url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function connectedKey() {
  return typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem(STORAGE_KEY) ?? '';
}

export function disconnectOpenRouter() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export async function connectOpenRouter() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  sessionStorage.setItem('aim.openrouter.pkce-verifier', verifier);
  const callback = `${location.origin}${location.pathname}`;
  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('callback_url', callback);
  url.searchParams.set('code_challenge', base64url(digest));
  url.searchParams.set('code_challenge_method', 'S256');
  location.assign(url);
}

export async function finishOpenRouterConnection() {
  const code = new URL(location.href).searchParams.get('code');
  const verifier = sessionStorage.getItem('aim.openrouter.pkce-verifier');
  if (!code || !verifier) return false;
  const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' })
  });
  const data = await response.json();
  if (!response.ok || typeof data.key !== 'string') throw new Error(data.error?.message ?? 'OpenRouter connection failed.');
  sessionStorage.setItem(STORAGE_KEY, data.key);
  sessionStorage.removeItem('aim.openrouter.pkce-verifier');
  history.replaceState({}, '', location.pathname);
  return true;
}
