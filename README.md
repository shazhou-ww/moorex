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

Install Moorex and its peer dependency:

```bash
npm install moorex mutative
# or
bun add moorex mutative
# or
yarn add moorex mutative
```

Import and create your first Moorex machine:

```typescript
import { createMoorex, type MoorexDefinition } from 'moorex';
import { create } from 'mutative';

// Define your types and create the definition
// (See Example section below for full details)
const definition: MoorexDefinition<YourState, YourSignal, YourEffect> = {
  initiate: () => ({ /* initial state */ }),
  transition: (signal) => (state) => create(state, (draft) => { /* update draft */ }),
  effectsAt: (state) => ({ /* return effects record */ }),
  runEffect: (effect, state) => ({ start: async () => {}, cancel: () => {} }),
};

// Create and use the machine
const machine = createMoorex(definition);
machine.on((event) => console.log(event));
machine.dispatch({ /* your signal */ });
```

## Immutability

All data types in Moorex (State, Signal, Effect) are **read-only/immutable**
using the `Immutable` type from
[mutative](https://github.com/unadlib/mutative).

Moorex requires `transition`, `effectsAt`, and `runEffect` to be **pure
functions** — they must not modify their inputs. Immutability protects against
accidental mutations that would violate this constraint and lead to bugs. All
state, signal, and effect objects are protected from modification, ensuring:

- **Purity guarantee**: Functions cannot accidentally mutate inputs
- **Correctness**: State transitions remain predictable and reproducible
- **Debuggability**: Eliminates entire classes of mutation-related bugs

All function parameters and return values in `MoorexDefinition` are immutable:

- `initiate()` returns `Immutable<State>`
- `transition(signal)` receives `Immutable<Signal>` and `Immutable<State>`,
  returns `Immutable<State>`
- `effectsAt(state)` receives `Immutable<State>`, returns
  `Record<string, Immutable<Effect>>`
- `runEffect(effect, state)` receives `Immutable<Effect>` and
  `Immutable<State>`

We strongly recommend using mutative's `create()` function for immutable updates:

```typescript
import { create } from 'mutative';

// In your transition function
transition: (signal) => (state) => {
  return create(state, (draft) => {
    draft.messages.push(signal);
    // Modify draft as needed - it's safe to mutate here
  });
}

// For simple updates, you can also use spread operators
transition: (signal) => (state) => {
  return {
    ...state,
    messages: [...state.messages, signal],
  };
}
```

## Example: Persistent Agent Driver

The example below sketches a resilient agent that decides what to do based on
its state.

```typescript
import { createMoorex, type MoorexDefinition } from './index';
import { create } from 'mutative';

// Define your signal types - these trigger state transitions
type Signal =
  | { type: 'user'; message: string }
  | { type: 'tool'; name: string; result: string }
  | { type: 'assistant'; message: string };

// Define your effect types - these represent side effects to run.
// Note: Effect types no longer need a `key` property; the Record key serves
// as the identifier.
type Effect =
  | { kind: 'call-llm'; prompt: string }
  | { kind: 'call-tool'; id: string; name: string; input: string };

// Define your state shape
type AgentState = {
  messages: Signal[];
  pendingMessages: Signal[];
  pendingToolCalls: { id: string; name: string; input: string }[];
};

const definition: MoorexDefinition<AgentState, Signal, Effect> = {
  // Initialization function that returns the initial state
  initiate: () => ({
    messages: [],
    pendingMessages: [],
    pendingToolCalls: [],
  }),

  // Pure state transition function: (signal) => (state) => newState.
  // This defines how signals transform your state.
  // All parameters and return values are Immutable (see Immutability section
  // above).
  transition: (signal) => (state) => {
    // Implement state transition logic using mutative or spread operators:
    // - Add signal to messages array.
    // - Update pendingMessages based on signal type (add user messages,
    //   remove processed ones)
    // - Update pendingToolCalls based on signal type (remove completed tool
    //   calls)
    // - Return new immutable state.
    // Example with mutative:
    //   return create(state, (draft) => { draft.messages.push(signal); });
    return state;
  },

  // Effect selector: (state) => Record<string, Effect>
  // Returns a Record where keys are effect identifiers and values are effects.
  // Moorex uses these keys to reconcile effects (cancel obsolete, start new)
  effectsAt: (state) => {
    // Based on state, determine which effects should be running:
    // - If pendingMessages exist, return LLM call effect with key like
    //   `llm:${promptHash}`
    // - If pendingToolCalls exist, return tool execution effects with keys
    //   like `tool:${id}`
    // - Return empty object {} if no effects needed
    // - Effect objects must be immutable (use mutative or object literals)
    // Example structure:
    //   { 'effect-key': { kind: 'call-llm', prompt: '...' } }
    return {};
  },

  // Effect runner: (effect, state) => { start, cancel }
  // Creates an initializer for running a specific effect.
  // Note: receives both effect and the state that generated this effect.
  runEffect: (effect, state) => {
    if (effect.kind === 'call-llm') {
      return {
        // Async function that runs the effect and dispatches signals on
        // completion
        start: async (dispatch) => {
          // Call LLM with effect.prompt
          // When done, dispatch assistant message signal
          // dispatch({ type: 'assistant', message: completion });
        },
        // Function to cancel the effect if it's no longer needed
        cancel: () => {
          // Cancel the LLM call (e.g., abort fetch, close connection)
        },
      };
    }
    if (effect.kind === 'call-tool') {
      return {
        start: async (dispatch) => {
          // Execute tool with effect.name and effect.input.
          // When done, dispatch tool result signal:
          // dispatch({ type: 'tool', name: effect.id, result: '...' });
        },
        cancel: () => {
          // Cancel tool execution if possible
        },
      };
    }
    // TypeScript exhaustiveness check
    throw new Error(`Unknown effect kind ${(effect satisfies never).kind}`);
  },
};

// Create the Moorex machine instance
const agent = createMoorex(definition);

// Subscribe to events (state updates, effect lifecycle, etc.)
agent.on((event) => {
  console.log('[agent-event]', event);
  // event.type can be: 'signal-received', 'state-updated', 'effect-started',
  // 'effect-completed', 'effect-canceled', 'effect-failed'
});

// Dispatch signals to trigger state transitions
agent.dispatch({
  type: 'user',
  message: 'Summarize the latest log entries.',
});

// Get current state
const currentState = agent.getState();
```

Even if the agent restarts, hydrating `AgentState` and letting effect
reconciliation run will resume or cancel effects exactly as required. The Record
keys returned by `effectsAt` serve as stable identifiers for effects across
restarts—effects with matching keys are considered the same effect.

## Effect Reconciliation

On every state change Moorex:

1. Calls `effectsAt(state)` to compute the desired effect set as a Record
   (key-value map).
2. Cancels running effects whose keys disappeared from the Record.
3. Starts any new effects whose keys were introduced in the Record.
4. Leaves untouched effects whose keys are still present.

The Record's keys serve as effect identifiers for reconciliation, so Effect
types no longer need to have a `key` property.

Each effect's lifecycle is managed by the `runEffect(effect, state)` return value:

- `runEffect(effect, state)` receives the effect and the state that generated
  it, returning an initializer with `start` and `cancel` methods.
- `start(dispatch)` launches the effect and resolves when it finishes. Use
  `dispatch` to send signals back to the machine.
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

## License

MIT

