<div align="center">
  <img src="https://raw.githubusercontent.com/scalar-app/.github/main/profile/assets/scalar.png" alt="Scalar" width="96" />
  <h1>@scalar/ai</h1>
  <p>The intelligence layer behind Scalar Command.</p>
</div>

---

`@scalar/ai` turns a sentence like "what do I have due this week, and can you block two hours for the problem set" into an answer plus a set of changes the person can approve. It is a plain TypeScript package: no database, no HTTP server, no framework. The API supplies the tools and owns authorization, so this package can be read, tested and reasoned about on its own.

## Install and build

Requires Node 24 or newer.

```bash
pnpm install
pnpm build
```

Not on npm yet; consumers link it: `"@scalar/ai": "link:../ai"`.

## The shape of it

```
provider.ts                     vendor neutral model interface
providers/anthropic.ts          Anthropic implementation (Claude Opus 5, adaptive thinking)
providers/openai-compatible.ts  OpenAI, Ollama and anything speaking the same API
providers/factory.ts            picks a provider from configuration
providers/scripted.ts           replays a fixed script, for tests and for running with AI disabled
tools/registry.ts               tool definitions and the read/suggest/write classification
tools/scalar-tools.ts           the eight Stage 1 tools
prompt.ts                       system prompt and external content wrapping
command/loop.ts                 one Command turn
scheduling.ts                   free time arithmetic, computed rather than generated
planner/plan.ts                 builds a proposed plan from tasks and availability
planner/availability.ts         open time once events and working hours are applied
time.ts                         time zone and calendar day arithmetic
```

## Running a Command turn

```ts
import { AnthropicProvider, ToolRegistry, createScalarTools, runCommand } from '@scalar/ai';

const registry = new ToolRegistry(createScalarTools(executors));
const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });

const result = await runCommand({
  provider,
  registry,
  context: { workspaceId, userId, today: '2026-03-10', timeZone: 'America/New_York' },
  messages: [{ role: 'user', content: 'block two hours for the problem set tomorrow' }],
});
```

`result` carries the answer, the calls that ran, the proposals waiting on approval, token usage, and a `stopReason` of `answered`, `needs_approval`, `refused`, `max_steps` or `max_tokens`.

`executors` is yours to supply. It is the seam where this package stops and the database begins.

## What actually happens, and what only gets proposed

Every tool is classified by what it can do:

| Classification | Example                                       | Behaviour                                                    |
| -------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `read`         | `get_today`, `search_tasks`, `find_free_time` | Runs immediately. Returns things the person can already see. |
| `suggest`      | a draft, a plan                               | Produces a proposal. Changes nothing.                        |
| `write`        | `create_task`, `update_task`, `schedule_task` | Never runs here. Becomes a proposal.                         |

The classification decides this, not the model's intent and not the wording of the request. When the model calls a write tool, the loop validates the input, records a proposal with a plain language summary, and tells the model the change is pending and has not happened. The API executes an approved proposal later and re-checks permissions at that point.

The practical consequence: nothing in a person's workspace changes because a model decided it should. A person saw a sentence describing the change and said yes.

## Safety properties the tests hold in place

- A write tool call produces a proposal and no execution. Covered by `test/command.test.ts`.
- Model output is validated with zod before it reaches an executor. Invalid input becomes an error the model can recover from, never a call.
- A `suggest` or `write` tool cannot be defined without `describeAction`, so no approval prompt can be blank.
- A refusal stops the turn and returns no answer, rather than reading a partly filled response.
- Tool definitions sent to the model contain only name, description and schema. Executors never cross that line.
- `wrapExternalContent` marks text from email, calendar entries and course announcements as data. Delimiters are not a security control on their own, which is exactly why authorization lives in the tool layer instead.
- The loop stops after `maxSteps` rather than running until something gives.

## Scheduling is arithmetic, not generation

`findFreeSlots` computes gaps in a calendar: merges overlapping events, applies working hours in the person's time zone, skips anything in the past, and walks day by day so daylight saving changes stay correct. The model asks for free time; it does not work it out. Asking a language model to do calendar arithmetic that ordinary software does reliably is a way of making a system that is wrong sometimes for no reason.

```ts
import { findFreeSlots } from '@scalar/ai';

const slots = findFreeSlots({
  from: new Date('2026-03-10T00:00:00-04:00'),
  to: new Date('2026-03-11T00:00:00-04:00'),
  busy: events.map((event) => ({ startsAt: event.startsAt, endsAt: event.endsAt })),
  minutes: 120,
  dayStartHour: 9,
  dayEndHour: 21,
  timeZone: 'America/New_York',
});
```

## Model configuration

The Anthropic provider defaults to `claude-opus-5` with adaptive thinking. Depth is steered with `effort` rather than sampling parameters, which current models reject. No assistant prefill is used. `stop_reason` is checked before any content is read.

Anthropic, OpenAI, Ollama and anything speaking the OpenAI API ship already; `providers/factory.ts` picks between them from configuration. Anything else means implementing `ScalarModelProvider`. Nothing above that interface knows which vendor is answering.

## Development

```bash
pnpm install
pnpm test
pnpm lint && pnpm typecheck && pnpm build
```

Tests run against `ScriptedProvider`, so the suite is deterministic and needs no API key.

## Licence

AGPL-3.0-only. See [LICENSE](./LICENSE).
