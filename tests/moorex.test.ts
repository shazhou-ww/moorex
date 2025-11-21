import { describe, expect, test } from 'bun:test';
import { createMoorex, type MoorexDefinition, type MoorexEvent } from '../index';

type NumberSignal = 'noop' | 'toggle' | 'increment';
type NumberEffect = { key: string; label: string };

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error?: unknown) => void;
};

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const nextTick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('createMoorex', () => {
  test('starts effects defined by the initial state and emits completion', async () => {
    type State = { active: boolean };

    const deferred = createDeferred();
    let runCount = 0;

    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { active: true },
      transition: () => (state) => state,
      effectsAt: () => ({ alpha: { key: 'alpha', label: 'initial' } }),
      runEffect: (effect, state) => {
        runCount += 1;
        return {
          start: () => deferred.promise,
          cancel: deferred.resolve,
        };
      },
    };

    const moorex = createMoorex(definition);
    const events: MoorexEvent<State, NumberSignal, NumberEffect>[] = [];
    moorex.on((event) => events.push(event));

    expect(runCount).toBe(1);

    deferred.resolve();
    await deferred.promise;
    await nextTick();

    const completion = events.find(
      (event): event is Extract<typeof event, { type: 'effect-completed' }> =>
        event.type === 'effect-completed',
    );

    expect(completion?.effect.key).toBe('alpha');
    expect(completion?.effectCount).toBe(0);
  });

  test('cancels effects that are no longer requested', async () => {
    type State = { active: boolean };

    let cancelCalls = 0;
    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { active: true },
      transition: (signal) => (state) =>
        signal === 'toggle' ? { active: !state.active } : state,
      effectsAt: (state): Record<string, NumberEffect> => (state.active ? { alpha: { key: 'alpha', label: 'active' } } : {}),
      runEffect: (effect, state) => ({
        start: () => new Promise(() => {}),
        cancel: () => {
          cancelCalls += 1;
        },
      }),
    };

    const moorex = createMoorex(definition);
    const events: MoorexEvent<State, NumberSignal, NumberEffect>[] = [];
    moorex.on((event) => events.push(event));

    moorex.dispatch('toggle');
    await nextTick();

    expect(cancelCalls).toBe(1);
    const cancelEvent = events.find((event) => event.type === 'effect-canceled');
    expect(cancelEvent?.effect.key).toBe('alpha');
    expect(cancelEvent?.effectCount).toBe(0);

    const stateUpdated = events.find(
      (event): event is Extract<typeof event, { type: 'state-updated' }> =>
        event.type === 'state-updated',
    );
    expect(stateUpdated?.effectCount).toBe(0);
    expect(stateUpdated?.state.active).toBe(false);
  });

  test('allows running effects to dispatch new signals', async () => {
    type State = { count: number; active: boolean };

    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { count: 0, active: false },
      transition: (signal) => (state) => {
        if (signal === 'increment') return { count: state.count + 1, active: state.active };
        if (signal === 'toggle') return { count: state.count, active: !state.active };
        return state;
      },
      effectsAt: (state): Record<string, NumberEffect> =>
        state.active && state.count === 0 ? { alpha: { key: 'alpha', label: 'incrementer' } } : {},
      runEffect: (effect, state) => {
        const deferred = createDeferred();
        return {
          start: (dispatch) => {
            dispatch('increment');
            queueMicrotask(deferred.resolve);
            return deferred.promise;
          },
          cancel: deferred.resolve,
        };
      },
    };

    const moorex = createMoorex(definition);
    const events: MoorexEvent<State, NumberSignal, NumberEffect>[] = [];
    moorex.on((event) => events.push(event));

    moorex.dispatch('toggle');
    await nextTick();

    expect(moorex.getState().count).toBe(1);
    const signalEvent = events.find(
      (event): event is Extract<typeof event, { type: 'signal-received' }> =>
        event.type === 'signal-received' && event.signal === 'increment',
    );
    expect(signalEvent?.signal).toBe('increment');
    expect(signalEvent?.effectCount).toBeGreaterThanOrEqual(0);

    const stateUpdates = events.filter(
      (event): event is Extract<typeof event, { type: 'state-updated' }> =>
        event.type === 'state-updated',
    );
    expect(stateUpdates.at(-1)?.state.count).toBe(1);
    expect(stateUpdates.at(-1)?.effectCount).toBe(0);
  });

  test('ignores completion from cancelled effects', async () => {
    type State = { active: boolean };

    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { active: true },
      transition: (signal) => (state) =>
        signal === 'toggle' ? { active: !state.active } : state,
      effectsAt: (state): Record<string, NumberEffect> => (state.active ? { alpha: { key: 'alpha', label: 'active' } } : {}),
      runEffect: (effect, state) => {
        const deferred = createDeferred();
        return {
          start: () => deferred.promise,
          cancel: deferred.resolve,
        };
      },
    };

    const moorex = createMoorex(definition);
    const events: MoorexEvent<State, NumberSignal, NumberEffect>[] = [];
    moorex.on((event) => events.push(event));

    moorex.dispatch('toggle');
    await nextTick();
    await nextTick();

    const completed = events.find((event) => event.type === 'effect-completed');
    expect(completed).toBeUndefined();

    const canceled = events.find((event) => event.type === 'effect-canceled');
    expect(canceled?.effect.key).toBe('alpha');
    expect(canceled?.effectCount).toBe(0);
  });

  test('dedupes effects sharing the same key', async () => {
    type State = { stage: 'duplicate' | 'done' };

    let runCount = 0;
    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { stage: 'duplicate' },
      transition: () => (state) => state,
      effectsAt: () => ({
        alpha: { key: 'alpha', label: 'first' },
      }),
      runEffect: (effect, state) => {
        runCount += 1;
        return {
          start: () => Promise.resolve(),
          cancel: () => {},
        };
      },
    };

    createMoorex(definition);
    await nextTick();

    expect(runCount).toBe(1);
  });

  test('ignores dispatches from effects no longer tracked', async () => {
    type State = { count: number; active: boolean };

    let capturedDispatch: ((signal: NumberSignal) => void) | undefined;
    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { count: 0, active: true },
      transition: (signal) => (state) => {
        if (signal === 'increment') return { count: state.count + 1, active: state.active };
        if (signal === 'toggle') return { count: state.count, active: !state.active };
        return state;
      },
      effectsAt: (state): Record<string, NumberEffect> => (state.active ? { alpha: { key: 'alpha', label: 'active' } } : {}),
      runEffect: (effect, state) => {
        const pending = new Promise<void>(() => {});
        return {
          start: (dispatch) => {
            capturedDispatch = dispatch;
            return pending;
          },
          cancel: () => {
            const dispatchRef = capturedDispatch;
            if (dispatchRef) {
              queueMicrotask(() => dispatchRef('increment'));
            }
          },
        };
      },
    };

    const moorex = createMoorex(definition);
    const events: MoorexEvent<State, NumberSignal, NumberEffect>[] = [];
    moorex.on((event) => events.push(event));

    moorex.dispatch('toggle');
    await nextTick();
    await nextTick();

    expect(moorex.getState().count).toBe(0);
    const incrementSignal = events.find(
      (event): event is Extract<typeof event, { type: 'signal-received' }> =>
        event.type === 'signal-received' && event.signal === 'increment',
    );
    expect(incrementSignal).toBeUndefined();
    const stateUpdate = events.find(
      (event): event is Extract<typeof event, { type: 'state-updated' }> =>
        event.type === 'state-updated',
    );
    expect(stateUpdate?.state.active).toBe(false);
    expect(stateUpdate?.effectCount).toBe(0);
  });

  test('allows unsubscribing handlers', async () => {
    type State = { count: number };

    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { count: 0 },
      transition: (signal) => (state) =>
        signal === 'increment' ? { count: state.count + 1 } : state,
      effectsAt: () => ({}),
      runEffect: (effect, state) => {
        throw new Error('should not run');
      },
    };

    const moorex = createMoorex(definition);
    const events: MoorexEvent<State, NumberSignal, NumberEffect>[] = [];
    const unsubscribe = moorex.on((event) => events.push(event));

    unsubscribe();
    moorex.dispatch('increment');
    await nextTick();

    expect(events).toHaveLength(0);
  });

  test('emits effect-failed when cancel throws', async () => {
    type State = { active: boolean };

    const error = new Error('cancel failed');
    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { active: true },
      transition: (signal) => (state) =>
        signal === 'toggle' ? { active: !state.active } : state,
      effectsAt: (state): Record<string, NumberEffect> => (state.active ? { alpha: { key: 'alpha', label: 'active' } } : {}),
      runEffect: (effect, state) => ({
        start: () => new Promise(() => {}),
        cancel: () => {
          throw error;
        },
      }),
    };

    const moorex = createMoorex(definition);
    const events: MoorexEvent<State, NumberSignal, NumberEffect>[] = [];
    moorex.on((event) => events.push(event));

    moorex.dispatch('toggle');
    await nextTick();

    const failed = events.find(
      (event): event is Extract<typeof event, { type: 'effect-failed' }> =>
        event.type === 'effect-failed',
    );
    expect(failed?.effect.key).toBe('alpha');
    expect(failed?.error).toBe(error);
    expect(failed?.effectCount).toBe(0);
  });

  test('emits effect-failed when runEffect throws', async () => {
    type State = { shouldRun: boolean };

    const error = new Error('boom');
    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { shouldRun: false },
      transition: (signal) => (state) =>
        signal === 'toggle' ? { shouldRun: !state.shouldRun } : state,
      effectsAt: (state): Record<string, NumberEffect> => (state.shouldRun ? { alpha: { key: 'alpha', label: 'boom' } } : {}),
      runEffect: (effect, state) => {
        throw error;
      },
    };

    const moorex = createMoorex(definition);
    const events: MoorexEvent<State, NumberSignal, NumberEffect>[] = [];
    moorex.on((event) => events.push(event));

    moorex.dispatch('toggle');
    await nextTick();

    const failed = events.find(
      (event): event is Extract<typeof event, { type: 'effect-failed' }> =>
        event.type === 'effect-failed',
    );
    expect(failed?.effect.key).toBe('alpha');
    expect(failed?.error).toBe(error);
    expect(failed?.effectCount).toBe(0);
  });

  test('emits effect-failed when completion rejects', async () => {
    type State = { active: boolean };

    const deferred = createDeferred();
    const error = new Error('reject');
    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { active: true },
      transition: () => (state) => state,
      effectsAt: (): Record<string, NumberEffect> => ({ alpha: { key: 'alpha', label: 'active' } }),
      runEffect: (effect, state) => ({
        start: () => deferred.promise,
        cancel: () => {},
      }),
    };

    const moorex = createMoorex(definition);
    const events: MoorexEvent<State, NumberSignal, NumberEffect>[] = [];
    moorex.on((event) => events.push(event));

    deferred.reject(error);
    try {
      await deferred.promise;
    } catch {
      // ignore
    }
    await nextTick();

    const failed = events.find(
      (event): event is Extract<typeof event, { type: 'effect-failed' }> =>
        event.type === 'effect-failed',
    );
    expect(failed?.effect.key).toBe('alpha');
    expect(failed?.error).toBe(error);
    expect(failed?.effectCount).toBe(0);
  });
});

