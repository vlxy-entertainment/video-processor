---
scope: "Repo-wide coding conventions enforced across the TypeScript codebase: type definitions, import style, and data-access layering."
not: "Runtime/tooling setup (see tech-stack.md) or video-pipeline domain logic (see patterns-video-pipeline.md)."
anchors:
  - "Types are Zod-first: schema then z.infer; never use any"
  - "TypeScript path aliases (@/, @/services/, ...) are mandatory"
  - "All DB access goes through service classes + Zod validation"
---

## Types are Zod-first: schema then z.infer; never use any

For any new type, define a Zod schema first, then derive the TS type with `z.infer`. Existing schemas live in `src/types/index.ts` (`VideoProcessingQueueItemSchema`, `VideoSchema`, `TiktokAccountSchema`, `EnvConfigSchema`). `any` is banned (`.cursor/rules/rules.mdc`).

**Why:** Rows and env vars are validated at runtime through these schemas on the way in/out; adding a field means updating the schema, not just a TS interface.

---

## TypeScript path aliases (@/, @/services/, ...) are mandatory

Imports use `@/`, `@/config/`, `@/services/`, `@/types/`, `@/utils/` (configured in `tsconfig.json`). Build resolves them via `tsc-alias`. Avoid deep relative imports across folders.

**Why:** Consistent with the whole codebase; deep relative paths break the convention and the alias-based build step.

---

## All DB access goes through service classes + Zod validation

Business logic never instantiates raw Supabase clients. Access goes through service classes (`QueueService`, `VideoService`, `TiktokAccountService`) which validate every row through Zod schemas. A Supabase MCP server is configured (`.cursor/mcp.json`); prefer it for live DB inspection over hand-written SQL.

**Why:** Centralizes validation and the service-role client (which bypasses RLS), keeping query logic and schema enforcement in one place.

---
