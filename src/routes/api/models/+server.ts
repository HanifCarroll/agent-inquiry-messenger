import { json } from '@sveltejs/kit';
import { catalog, requestApiKey, price, USER_KEY_HEADER } from '$lib/server/protocol';

export async function GET({ request, platform }) {
  try {
    const userKey = request.headers.get(USER_KEY_HEADER)?.trim();
    if (userKey && (userKey.length > 512 || !userKey.startsWith('sk-or-'))) return json({ error: 'That OpenRouter connection is invalid.' }, { status: 400 });
    const { apiKey, guest } = requestApiKey(userKey, (platform as any)?.env);
    const models = await catalog(apiKey, guest);
    return json({ models: models.map(model => ({ id: model.id, name: model.name ?? model.id, pricing: price(model), context_length: model.contextLength })) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'OpenRouter could not be reached. Try again.' }, { status: 502 });
  }
}
