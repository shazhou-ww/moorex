# Moorex: Persistent Moore Machines for Agents

Moorex is a generic asynchronous Moore machine. It keeps track of state, drives
effects strictly from the current state, and reconciles those effects whenever
the state changes. The design originated from building **persistent AI agents**
that must survive crashes, restarts, or migrations while resuming unfinished
work.

## Why Moorex for Persistent Agents?

An AI agent often interacts with users and tools while invoking large language
models (LLMs). The agent can crash mid-task, be suspended, or migrate across
nodes. To resume faithfully, we must restore:

- The agent's internal state (messages, pending tool calls, etc.)
- Every in-flight side effect (outstanding LLM invocations, tool executions)

This agent fits the Moore machine model beautifully: **state determines which
effects should be running**.

- **Signals**: user messages, tool messages, assistant messages.
- **State**: full conversation history, pending outbound messages, pending tool
  calls.
- **Effects**: actions implied by the state, e.g. invoking the LLM, executing a
  tool, or idling when nothing remains.

With Moorex, after rehydrating state we run effect reconciliation and the agent
continues exactly where it left off. No effect can exist without corresponding
state, and removing state automatically cancels redundant effects.

## Getting Started

Install dependencies:

```bash
bun install
```

Run tests:

```bash
bun test --coverage
```

## Example: Persistent Agent Driver

The example below sketches a resilient agent that decides what to do based on
its state.

```typescript
import { createMoorex, type MoorexDefinition } from './index';

type Signal =
  | { type: 'user'; message: string }
  | { type: 'tool'; name: string; result: string }
  | { type: 'assistant'; message: string };

type Effect =
  | { key: string; kind: 'call-llm'; prompt: string }
  | { key: string; kind: 'call-tool'; id: string; name: string; input: string };

type AgentState = {
  messages: Signal[];
  pendingMessages: Signal[];
  pendingToolCalls: { id: string; name: string; input: string }[];
};

const definition: MoorexDefinition<AgentState, Signal, Effect> = {
  initialState: {
    messages: [],
    pendingMessages: [],
    pendingToolCalls: [],
  },
  transition: (signal) => (state) => {
    // Simple placeholder transition logic.
    return {
      ...state,
      messages: [...state.messages, signal],
      pendingMessages:
        signal.type === 'user'
          ? [...state.pendingMessages, signal]
          : state.pendingMessages.filter((msg) => msg !== signal),
  pendingToolCalls:
    signal.type === 'tool'
      ? state.pendingToolCalls.filter((call) => call.id !== signal.name)
      : state.pendingToolCalls,
    };
  },
  effectsAt: (state) => {
    if (state.pendingMessages.length > 0) {
      const prompt = buildPrompt(state.messages, state.pendingMessages);
      return [{ key: `llm:${hash(prompt)}`, kind: 'call-llm', prompt }];
    }
    if (state.pendingToolCalls.length > 0) {
      const { id, name, input } = state.pendingToolCalls[0];
      return [{ key: `tool:${id}`, kind: 'call-tool', id, name, input }];
    }
    return [];
  },
  runEffect: (effect) => {
    if (effect.kind === 'call-llm') {
      return {
        start: async (dispatch) => {
          const completion = await callLLM(effect.prompt);
          dispatch({ type: 'assistant', message: completion });
        },
        cancel: () => cancelLLM(effect.prompt),
      };
    }
    if (effect.kind === 'call-tool') {
      return {
        start: async (dispatch) => {
          const result = await executeTool(effect.name, effect.input);
          dispatch({ type: 'tool', name: effect.id, result });
        },
        cancel: () => cancelTool(effect.name),
      };
    }
    throw new Error(`Unknown effect kind ${(effect satisfies never).kind}`);
  },
};

const agent = createMoorex(definition);

agent.on((event) => {
  console.log('[agent-event]', event);
});

agent.dispatch({ type: 'user', message: 'Summarize the latest log entries.' });
```

Even if the agent restarts, hydrating `AgentState` and letting effect
reconciliation run will resume or cancel effects exactly as required.

> The `buildPrompt`, `callLLM`, `cancelLLM`, `executeTool`, and `cancelTool`
> functions are placeholders you would provide.

## Effect Reconciliation

On every state change Moorex:

1. Calls `effectsAt(state)` to compute the desired effect set.
2. Deduplicates them by `effect.key`.
3. Cancels running effects whose keys disappeared.
4. Starts any new effects whose keys were introduced.
5. Leaves untouched effects whose keys are still present.

Each effect's lifecycle is managed by the `runEffect(effect)` return value:

- `start(dispatch)` launches the effect and resolves when it finishes.
- `cancel()` aborts the effect; Moorex calls this when the effect key is no
  longer needed.

Moorex tracks running effects in memory. If an effect completes or rejects, the
machine automatically removes it and emits the corresponding events.

## Event Timeline

Moorex exposes a single `on(handler)` subscription. Events arrive in the
following order for each dispatch batch:

1. **`signal-received`**: emitted once per signal when it is processed (after
   queueing, before effect reconciliation).
2. **`effect-started`**: emitted for each new effect begun during
   reconciliation.
3. **`effect-completed`** / **`effect-failed`** / **`effect-canceled`**:
   emitted asynchronously as effects finish, throw, or are cancelled.
4. **`state-updated`**: emitted once after the batch of signals reconciles and
   state is committed.

All events include `effectCount`, the number of effects still running after the
event has been processed.

## License

MIT
