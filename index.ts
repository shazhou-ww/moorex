type HasKey = { key: string };

type CancelFn = () => void;

type EffectController = {
  complete: Promise<void>;
  cancel: CancelFn;
};

export type MoorexDefinition<State, Signal, Effect extends HasKey> = {
  initialState: State;
  transition: (signal: Signal) => (state: State) => State;
  effectsAt: (state: State) => Effect[];
  runEffect: (
    effect: Effect,
    dispatch: (signal: Signal) => void,
  ) => EffectController;
};

export type MoorexEvent<State, Signal, Effect extends HasKey> =
  | { type: 'signal-received'; signal: Signal; state: State }
  | { type: 'effect-started'; effect: Effect }
  | { type: 'effect-completed'; effect: Effect }
  | { type: 'effect-canceled'; effect: Effect }
  | { type: 'effect-failed'; effect: Effect; error: unknown };

export type Moorex<State, Signal, Effect extends HasKey> = {
  dispatch(signal: Signal): void;
  on(handler: (event: MoorexEvent<State, Signal, Effect>) => void): CancelFn;
  getState(): State;
};

type RunningEffect<Effect extends HasKey> = {
  key: string;
  effect: Effect;
  controller: EffectController;
  token: symbol;
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
): boolean => running.get(entry.key)?.token === entry.token;

const cancelRunningEffect = <State, Signal, Effect extends HasKey>(
  entry: RunningEffect<Effect>,
  emit: (event: MoorexEvent<State, Signal, Effect>) => void,
) => {
  try {
    entry.controller.cancel();
  } catch (error) {
    emit({ type: 'effect-failed', effect: entry.effect, error });
    return;
  }
  emit({ type: 'effect-canceled', effect: entry.effect });
};

const attachCompletionHandlers = <State, Signal, Effect extends HasKey>(
  entry: RunningEffect<Effect>,
  running: Map<string, RunningEffect<Effect>>,
  emit: (event: MoorexEvent<State, Signal, Effect>) => void,
) => {
  entry.controller.complete
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
  dispatch: (signal: Signal) => void,
  running: Map<string, RunningEffect<Effect>>,
  emit: (event: MoorexEvent<State, Signal, Effect>) => void,
) => {
  const token = Symbol(effect.key);
  let controller: EffectController;
  try {
    controller = definition.runEffect(effect, dispatch);
  } catch (error) {
    emit({ type: 'effect-failed', effect, error });
    return;
  }

  const entry: RunningEffect<Effect> = {
    key: effect.key,
    effect,
    controller,
    token,
  };

  running.set(effect.key, entry);
  emit({ type: 'effect-started', effect });
  attachCompletionHandlers(entry, running, emit);
};

const reconcileEffects = <State, Signal, Effect extends HasKey>(
  state: State,
  definition: MoorexDefinition<State, Signal, Effect>,
  running: Map<string, RunningEffect<Effect>>,
  dispatch: (signal: Signal) => void,
  emit: (event: MoorexEvent<State, Signal, Effect>) => void,
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
    startEffect(effect, definition, dispatch, running, emit);
  }
};

export const createMoorex = <State, Signal, Effect extends HasKey>(
  definition: MoorexDefinition<State, Signal, Effect>,
): Moorex<State, Signal, Effect> => {
  const handlers = new Set<(event: MoorexEvent<State, Signal, Effect>) => void>();
  const running = new Map<string, RunningEffect<Effect>>();
  let state = selectInitialState<State, Signal, Effect>(definition);

  const emit = (event: MoorexEvent<State, Signal, Effect>) => {
    for (const handler of [...handlers]) {
      handler(event);
    }
  };

  const dispatch = (signal: Signal) => {
    state = definition.transition(signal)(state);
    emit({ type: 'signal-received', signal, state });
    reconcileEffects(state, definition, running, dispatch, emit);
  };

  const on = (handler: (event: MoorexEvent<State, Signal, Effect>) => void) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };

  reconcileEffects(state, definition, running, dispatch, emit);

  return {
    dispatch,
    on,
    getState: () => state,
  };
};