type SignalQueue<Signal> = {
  schedule(signal: Signal): void;
};

const createSignalQueue = <Signal>(
  processBatch: (signals: Signal[]) => void,
): SignalQueue<Signal> => {
  const queue: Signal[] = [];
  let draining = false;

  const drain = () => {
    if (draining) return;
    draining = true;
    queueMicrotask(() => {
      if (queue.length === 0) {
        draining = false;
        return;
      }

      const batch = queue.splice(0, queue.length);
      processBatch(batch);

      draining = false;
      if (queue.length > 0) drain();
    });
  };

  const schedule = (signal: Signal) => {
    queue.push(signal);
    drain();
  };

  return { schedule };
};
type HasKey = { key: string };

type CancelFn = () => void;

type EffectInitializer<Signal> = {
  start: (dispatch: (signal: Signal) => void) => Promise<void>;
  cancel: CancelFn;
};

export type MoorexDefinition<State, Signal, Effect extends HasKey> = {
  initialState: State;
  transition: (signal: Signal) => (state: State) => State;
  effectsAt: (state: State) => Effect[];
  runEffect: (
    effect: Effect,
  ) => EffectInitializer<Signal>;
};

type MoorexEventBase<State, Signal, Effect extends HasKey> =
  | { type: 'signal-received'; signal: Signal }
  | { type: 'state-updated'; state: State }
  | { type: 'effect-started'; effect: Effect }
  | { type: 'effect-completed'; effect: Effect }
  | { type: 'effect-canceled'; effect: Effect }
  | { type: 'effect-failed'; effect: Effect; error: unknown };

export type MoorexEvent<State, Signal, Effect extends HasKey> = MoorexEventBase<
  State,
  Signal,
  Effect
> & {
  effectCount: number;
};

export type Moorex<State, Signal, Effect extends HasKey> = {
  dispatch(signal: Signal): void;
  on(handler: (event: MoorexEvent<State, Signal, Effect>) => void): CancelFn;
  getState(): State;
};

type RunningEffect<Effect extends HasKey> = {
  key: string;
  effect: Effect;
  complete: Promise<void>;
  cancel: CancelFn;
};

const selectInitialState = <State, Signal, Effect extends HasKey>(
  definition: MoorexDefinition<State, Signal, Effect>,
): State => definition.initialState;

const dedupeByKey = <Effect extends HasKey>(effects: Effect[]): Map<string, Effect> => {
  const byKey = new Map<string, Effect>();
  for (const effect of effects) {
    if (!byKey.has(effect.key)) byKey.set(effect.key, effect);
  }
  return byKey;
};

const isCurrentEffect = <Effect extends HasKey>(
  running: Map<string, RunningEffect<Effect>>,
  entry: RunningEffect<Effect>,
): boolean => running.get(entry.key) === entry;

const cancelRunningEffect = <State, Signal, Effect extends HasKey>(
  entry: RunningEffect<Effect>,
  emit: (event: MoorexEventBase<State, Signal, Effect>) => void,
) => {
  try {
    entry.cancel();
  } catch (error) {
    emit({ type: 'effect-failed', effect: entry.effect, error });
    return;
  }
  emit({ type: 'effect-canceled', effect: entry.effect });
};

const attachCompletionHandlers = <State, Signal, Effect extends HasKey>(
  entry: RunningEffect<Effect>,
  running: Map<string, RunningEffect<Effect>>,
  emit: (event: MoorexEventBase<State, Signal, Effect>) => void,
) => {
  entry.complete
    .then(() => {
      if (!isCurrentEffect(running, entry)) return;
      running.delete(entry.key);
      emit({ type: 'effect-completed', effect: entry.effect });
    })
    .catch((error) => {
      if (!isCurrentEffect(running, entry)) return;
      running.delete(entry.key);
      emit({ type: 'effect-failed', effect: entry.effect, error });
    });
};

const startEffect = <State, Signal, Effect extends HasKey>(
  effect: Effect,
  definition: MoorexDefinition<State, Signal, Effect>,
  scheduleSignal: (signal: Signal) => void,
  running: Map<string, RunningEffect<Effect>>,
  emit: (event: MoorexEventBase<State, Signal, Effect>) => void,
) => {
  let initializer: EffectInitializer<Signal>;
  try {
    initializer = definition.runEffect(effect);
  } catch (error) {
    emit({ type: 'effect-failed', effect, error });
    return;
  }

  const entry: RunningEffect<Effect> = {
    key: effect.key,
    effect,
    complete: Promise.resolve(),
    cancel: initializer.cancel,
  };
  running.set(effect.key, entry);

  const guardedDispatch = (signal: Signal) => {
    if (running.get(effect.key) !== entry) return;
    scheduleSignal(signal);
  };

  let completion: Promise<void>;
  try {
    completion = Promise.resolve(initializer.start(guardedDispatch));
  } catch (error) {
    running.delete(effect.key);
    emit({ type: 'effect-failed', effect, error });
    return;
  }

  entry.complete = completion;

  emit({ type: 'effect-started', effect });
  attachCompletionHandlers(entry, running, emit);
};

const reconcileEffects = <State, Signal, Effect extends HasKey>(
  state: State,
  definition: MoorexDefinition<State, Signal, Effect>,
  running: Map<string, RunningEffect<Effect>>,
  scheduleSignal: (signal: Signal) => void,
  emit: (event: MoorexEventBase<State, Signal, Effect>) => void,
) => {
  const desired = dedupeByKey(definition.effectsAt(state));

  for (const [key, entry] of [...running]) {
    if (!desired.has(key)) {
      running.delete(key);
      cancelRunningEffect(entry, emit);
    }
  }

  for (const [key, effect] of desired) {
    if (running.has(key)) continue;
    startEffect(effect, definition, scheduleSignal, running, emit);
  }
};

export const createMoorex = <State, Signal, Effect extends HasKey>(
  definition: MoorexDefinition<State, Signal, Effect>,
): Moorex<State, Signal, Effect> => {
  const handlers = new Set<(event: MoorexEvent<State, Signal, Effect>) => void>();
  const running = new Map<string, RunningEffect<Effect>>();
  let state = selectInitialState<State, Signal, Effect>(definition);
  let workingState = state;

  const emit = (event: MoorexEventBase<State, Signal, Effect>) => {
    const enriched: MoorexEvent<State, Signal, Effect> = {
      ...event,
      effectCount: running.size,
    };
    for (const handler of [...handlers]) {
      handler(enriched);
    }
  };

  const { schedule: scheduleSignal } = createSignalQueue<Signal>((signals) => {
    workingState = signals.reduce((current, signal) => {
      emit({ type: 'signal-received', signal });
      return definition.transition(signal)(current);
    }, workingState);

    synchronizeEffects();
    state = workingState;
    emit({ type: 'state-updated', state });
  });

  const synchronizeEffects = () => {
    let snapshot: State;
    do {
      snapshot = workingState;
      reconcileEffects(snapshot, definition, running, scheduleSignal, emit);
    } while (snapshot !== workingState);
  };

  const dispatch = (signal: Signal) => {
    scheduleSignal(signal);
  };

  const on = (handler: (event: MoorexEvent<State, Signal, Effect>) => void) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };

  synchronizeEffects();

  return {
    dispatch,
    on,
    getState: () => state,
  };
};