---
paths:
  - "packages/platform/src/ai/**"
  - "packages/core/src/modules/ai-features/**"
  - "prompts/**"
  - "evals/**"
---

# AI rules

- All model calls go through `platform/ai` (`ai.generate`, `ai.structured`, `ai.batch`, `ai.embed`). No direct SDK calls elsewhere.
- Model IDs only from env (`AI_MODEL_FAST`, `AI_MODEL_SMART`, `AI_EMBED_MODEL`). Never hard-code a model name.
- Prompts are versioned files: `prompts/<feature>/v<N>.md` with front-matter (model tier, max tokens, output schema name). Bump the version for any change; keep old versions.
- Structured output only for anything the system consumes: define a Zod schema, request JSON via tool use / structured output, validate, retry once on invalid output, then fail with a clear error.
- Facts are injected, never generated: price, size, bedrooms, location, commission, legal text and dates come from data. Prompts must say so, and outputs are checked (numbers in output must match input).
- Every call records an `ai_jobs` row (feature, tenant, model, tokens, cost, latency, status) and counts against `ai_usage_monthly`. Enforce per-tenant and per-plan caps before calling.
- Bulk work (translations, unique site content, re-tagging) uses the batch API through `ai.batch` and runs in the `ai` worker pool.
- Cache by input hash (`feature + promptVersion + normalized input`) to avoid paying twice.
- Minimize PII: send only what the feature needs; never send client emails/phones to the model unless the feature requires it (e.g., the conversational agent).
- Evals: each feature has `evals/<feature>/*.jsonl` cases and checks; `pnpm ai:eval <feature>` must pass before a prompt version ships.
- Outputs shown to buyers pass the white-label sanitizer. AI text is stored with `origin = AI_DRAFT` until reviewed, unless the feature spec allows auto-publish (unique site content, captions).
