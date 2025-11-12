# Moorex for LLM-Driven Agents

## Name

moorex

## Description

Moorex is an asynchronous Moore machine runtime that keeps agent state and side
effects in sync. It is designed for persistent AI agents that must survive
crashes, restarts, or migrations while resuming pending LLM interactions and
tool executions safely.

## Usage

```typescript
import { createMoorex, type MoorexDefinition } from 'moorex';
```

> Prepare the agent definition: describe state transitions, desired effects, and how to run them.

```typescript
const definition: MoorexDefinition<AgentState, AgentSignal, AgentEffect> = {
  initialState,
  transition: (signal) => (state) => reduceState(state, signal),
  effectsAt: (state) => decideEffects(state),
  runEffect: (effect) => buildEffectRunner(effect),
};
```

> Spin up the Moorex agent, subscribe to events, and dispatch the first user message.

```typescript
const agent = createMoorex(definition);

agent.on((event) => {
  console.log(event);
});

agent.dispatch({ type: 'user', message: 'Summarize the latest log entries.' });
```

### Definition Parameters

- `initialState`: hydrated agent state at boot.
- `transition(signal)(state)`: pure reducer that applies an incoming signal to produce the next state.
- `effectsAt(state)`: returns the set of effects implied by the state (deduped by effect key).
- `runEffect(effect)`: returns `{ start, cancel }` to execute and abort each effect; Moorex injects a guarded dispatch into `start`.

