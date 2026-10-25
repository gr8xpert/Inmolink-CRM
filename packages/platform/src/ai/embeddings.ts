import type { EmbeddingProvider } from './provider';

/**
 * Embeddings (ADR 0008 #7). Anthropic has no embeddings endpoint, so a multilingual embedding provider (and its data
 * processing terms) is a separate choice. Until it is made, `AI_EMBED_PROVIDER=none`: the gateway has no embedding
 * provider and `ai.embed` fails fast with `AI_UNAVAILABLE` (reason `EMBEDDINGS_DISABLED`) — callers fall back to
 * keyword/structured search. A real provider is one more `EmbeddingProvider` here plus an `AI_EMBED_PROVIDER` value.
 */
export function embeddingProviderFor(settings: {
  provider: 'none';
  model: string | undefined;
}): EmbeddingProvider | null {
  switch (settings.provider) {
    case 'none':
      return null;
  }
}
