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
      effectsAt: () => [{ key: 'alpha', label: 'initial' }],
      runEffect: () => {
        runCount += 1;
        return {
          complete: deferred.promise,
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
  });

  test('cancels effects that are no longer requested', async () => {
    type State = { active: boolean };

    let cancelCalls = 0;
    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { active: true },
      transition: (signal) => (state) =>
        signal === 'toggle' ? { active: !state.active } : state,
      effectsAt: (state) => (state.active ? [{ key: 'alpha', label: 'active' }] : []),
      runEffect: () => ({
        complete: new Promise(() => {}),
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
  });

  test('allows running effects to dispatch new signals', async () => {
    type State = { count: number };

    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { count: 0 },
      transition: (signal) => (state) => {
        if (signal === 'increment') return { count: state.count + 1 };
        return state;
      },
      effectsAt: (state) =>
        state.count === 0 ? [{ key: 'alpha', label: 'incrementer' }] : [],
      runEffect: (_effect, dispatch) => {
        queueMicrotask(() => dispatch('increment'));
        return {
          complete: Promise.resolve(),
          cancel: () => {},
        };
      },
    };

    const moorex = createMoorex(definition);
    const events: MoorexEvent<State, NumberSignal, NumberEffect>[] = [];
    moorex.on((event) => events.push(event));

    await nextTick();

    expect(moorex.getState().count).toBe(1);
    const signalEvent = events.find(
      (event): event is Extract<typeof event, { type: 'signal-received' }> =>
        event.type === 'signal-received',
    );
    expect(signalEvent?.signal).toBe('increment');
  });

  test('ignores completion from cancelled effects', async () => {
    type State = { active: boolean };

    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { active: true },
      transition: (signal) => (state) =>
        signal === 'toggle' ? { active: !state.active } : state,
      effectsAt: (state) => (state.active ? [{ key: 'alpha', label: 'active' }] : []),
      runEffect: () => {
        const deferred = createDeferred();
        return {
          complete: deferred.promise,
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
  });

  test('dedupes effects sharing the same key', async () => {
    type State = { stage: 'duplicate' | 'done' };

    let runCount = 0;
    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { stage: 'duplicate' },
      transition: () => (state) => state,
      effectsAt: () => [
        { key: 'alpha', label: 'first' },
        { key: 'alpha', label: 'second' },
      ],
      runEffect: () => {
        runCount += 1;
        return {
          complete: Promise.resolve(),
          cancel: () => {},
        };
      },
    };

    createMoorex(definition);
    await nextTick();

    expect(runCount).toBe(1);
  });

  test('allows unsubscribing handlers', async () => {
    type State = { count: number };

    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { count: 0 },
      transition: (signal) => (state) =>
        signal === 'increment' ? { count: state.count + 1 } : state,
      effectsAt: () => [],
      runEffect: () => {
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
      effectsAt: (state) => (state.active ? [{ key: 'alpha', label: 'active' }] : []),
      runEffect: () => ({
        complete: new Promise(() => {}),
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
  });

  test('emits effect-failed when runEffect throws', async () => {
    type State = { shouldRun: boolean };

    const error = new Error('boom');
    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { shouldRun: false },
      transition: (signal) => (state) =>
        signal === 'toggle' ? { shouldRun: !state.shouldRun } : state,
      effectsAt: (state) => (state.shouldRun ? [{ key: 'alpha', label: 'boom' }] : []),
      runEffect: () => {
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
  });

  test('emits effect-failed when completion rejects', async () => {
    type State = { active: boolean };

    const deferred = createDeferred();
    const error = new Error('reject');
    const definition: MoorexDefinition<State, NumberSignal, NumberEffect> = {
      initialState: { active: true },
      transition: () => (state) => state,
      effectsAt: () => [{ key: 'alpha', label: 'active' }],
      runEffect: () => ({
        complete: deferred.promise,
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
  });
});

