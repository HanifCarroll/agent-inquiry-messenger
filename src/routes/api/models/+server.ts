import { json } from '@sveltejs/kit';
import { catalog, price } from '$lib/server/protocol';

export async function GET() {
  try {
    const models = await catalog();
    return json({ models: models.map(model => ({ id: model.id, name: model.name ?? model.id, pricing: price(model), context_length: model.contextLength })) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'OpenRouter could not be reached. Try again.' }, { status: 502 });
  }
}
