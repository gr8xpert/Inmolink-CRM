# ADR 0008 — AI gateway and model defaults

- **Status:** Accepted (design and defaults; gateway implemented in S12-01, needs H3 for the provider account)
- **Date:** 2026-10-11
- **Task:** S0-16 (PLAN §2 #6, §3 #47 #55, §8)

## Context

AI shows up in about 15 features (PLAN §8): translations, listing descriptions, the sanitizer, search, matching, extraction, chat and more. Without one entry point, each feature would pick its own model, retries, caching and cost tracking. Model IDs change several times a year, so a hard-coded ID becomes a code change for every upgrade. Bulk work (translations for every enabled locale, per-site content) dominates volume and is not latency-sensitive.

## Decision

1. **One gateway, `packages/platform/src/ai`.** Its API is `ai.generate`, `ai.structured` (validated against a Zod schema, one repair retry), `ai.batch` and `ai.embed`. It owns the provider abstraction, timeouts, retries, the circuit breaker, a response cache keyed by input hash, and usage accounting (`ai_jobs`, `ai_usage_monthly`). Modules never import a provider SDK.
2. **Two tiers, set by environment, never hard-coded:** `AI_MODEL_FAST` for bulk and simple tasks, and `AI_MODEL_SMART` for complex reasoning and hard documents. Features ask for a tier, not a model.
3. **Defaults on 2026-10-11** (`.env.example` and production config; change them here when upgrading):

   | Tier | Default model ID | Used for |
   |---|---|---|
   | `AI_MODEL_FAST` | `claude-haiku-5-5` | translations, Listing Studio drafts, captions, sanitizer, unique site content, NL search parsing |
   | `AI_MODEL_SMART` | `claude-opus-5-5` | new-build price-list extraction, conversational agent, CRM copilot |

   `claude-sonnet-5-5` is the candidate to replace SMART for cost. Switch only when `pnpm ai:eval` shows that quality holds for each SMART feature. Prices are not recorded here: they live in the provider's pricing page and in `ai_usage_monthly`.
4. **Bulk goes through the provider's Batch API** (about half price, asynchronous) through `ai.batch`. Bulk work includes per-locale translations, unique site content and re-tagging. Interactive features call directly.
5. **Prompt caching:** prompts keep their stable part (system prompt, schema, examples) first and the variable input last, so provider prefix caching applies. Prompts live as versioned files (`prompt_versions`), and an eval set per feature runs in CI before a prompt change ships.
6. **Budgets:** per-tenant monthly soft and hard caps per plan. At the hard cap the gateway returns `AI_BUDGET_EXCEEDED` without calling the provider.
7. **Embeddings** go through the same provider abstraction with a multilingual embedding provider, chosen in S12-01 and recorded here.
8. **Safety rules (PLAN §2 #6):** AI never writes prices, commission, legal text or facts. Those are injected from data. Outputs that reach clients are marked `AI_DRAFT` until reviewed and pass the white-label sanitizer. No client PII is sent unless the feature needs it, and AI providers are listed as sub-processors.
9. **Degrade, don't fail:** AI calls run in worker jobs or behind timeouts with a "try later" response. Core flows never wait on AI.

## Consequences

- A model upgrade is an env change plus an eval run, with no code change.
- Response caching and batching make repeated and bulk work cheap. Cost is visible per tenant and per site in the staff console.
- Provider-specific features (structured outputs, prompt caching, the batch API) are used inside the gateway only, so a second provider means one new adapter.
- Refusals and provider errors are normal outcomes the gateway maps to typed errors. Features must handle them.
