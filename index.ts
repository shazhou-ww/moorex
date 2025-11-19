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

/**
 * 定义 Moore 机器的配置。
 *
 * Moorex 是一个通用的异步 Moore 机器，它跟踪状态，严格从当前状态驱动 effects，
 * 并在状态改变时协调这些 effects。设计初衷是构建持久化的 AI agents，这些 agents
 * 必须在崩溃、重启或迁移时存活，同时能够恢复未完成的工作。
 *
 * @template State - 机器的状态类型
 * @template Signal - 信号类型，用于触发状态转换
 * @template Effect - Effect 类型，必须包含 `key: string` 属性
 */
export type MoorexDefinition<State, Signal, Effect extends HasKey> = {
  /** 初始状态 */
  initialState: State;
  /**
   * 状态转换函数。
   * 接收一个信号，返回一个函数，该函数接收当前状态并返回新状态。
   */
  transition: (signal: Signal) => (state: State) => State;
  /**
   * 根据当前状态计算应该运行的 effects。
   * 返回的 effects 会根据 `key` 去重。
   */
  effectsAt: (state: State) => Effect[];
  /**
   * 运行一个 effect。
   * 返回一个初始化器，包含 `start` 和 `cancel` 方法。
   */
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

/**
 * Moorex 机器发出的事件。
 *
 * 所有事件都包含 `effectCount` 字段，表示事件处理时仍在运行的 effects 数量。
 *
 * 事件类型包括：
 * - `signal-received`: 信号被接收并处理
 * - `state-updated`: 状态已更新
 * - `effect-started`: Effect 已启动
 * - `effect-completed`: Effect 成功完成
 * - `effect-canceled`: Effect 被取消
 * - `effect-failed`: Effect 失败（包含错误信息）
 *
 * @template State - 机器的状态类型
 * @template Signal - 信号类型
 * @template Effect - Effect 类型
 */
export type MoorexEvent<State, Signal, Effect extends HasKey> = MoorexEventBase<
  State,
  Signal,
  Effect
> & {
  /** 当前仍在运行的 effects 数量 */
  effectCount: number;
};

/**
 * Moorex 机器实例。
 *
 * 提供状态管理、信号分发和事件订阅功能。
 *
 * @template State - 机器的状态类型
 * @template Signal - 信号类型
 * @template Effect - Effect 类型
 */
export type Moorex<State, Signal, Effect extends HasKey> = {
  /**
   * 分发一个信号以触发状态转换。
   * 信号会被加入队列，在下一个微任务中批量处理。
   */
  dispatch(signal: Signal): void;
  /**
   * 订阅事件。
   * 返回一个取消订阅的函数。
   *
   * @param handler - 事件处理函数
   * @returns 取消订阅的函数
   */
  on(handler: (event: MoorexEvent<State, Signal, Effect>) => void): CancelFn;
  /**
   * 获取当前状态。
   * 返回已提交的状态（不包括正在处理中的 workingState）。
   */
  getState(): State;
};

type RunningEffect<Effect extends HasKey> = {
  key: string;
  effect: Effect;
  complete: Promise<void>;
  cancel: CancelFn;
};

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



/**
 * 创建一个 Moorex 机器实例。
 *
 * Moorex 是一个通用的异步 Moore 机器，它：
 * 1. 跟踪状态，通过信号触发状态转换
 * 2. 根据当前状态自动管理 effects
 * 3. 在状态改变时协调 effects（取消不需要的，启动新的）
 * 4. 提供事件订阅机制，监听状态和 effect 的变化
 *
 * 设计用于构建持久化的 AI agents，这些 agents 必须在崩溃、重启或迁移时存活，
 * 同时能够恢复未完成的工作。通过重新加载状态并运行 effect 协调，agent 可以
 * 从上次中断的地方继续。
 *
 * @example
 * ```typescript
 * const definition: MoorexDefinition<State, Signal, Effect> = {
 *   initialState: { count: 0 },
 *   transition: (signal) => (state) => ({ ...state, count: state.count + 1 }),
 *   effectsAt: (state) => state.count > 0 ? [{ key: 'effect-1' }] : [],
 *   runEffect: (effect) => ({
 *     start: async (dispatch) => { },
 *     cancel: () => { }
 *   })
 * };
 *
 * const moorex = createMoorex(definition);
 * moorex.on((event) => console.log('Event:', event));
 * moorex.dispatch({ type: 'increment' });
 * ```
 *
 * @template State - 机器的状态类型
 * @template Signal - 信号类型，用于触发状态转换
 * @template Effect - Effect 类型，必须包含 `key: string` 属性
 * @param definition - Moore 机器的定义配置
 * @returns Moorex 机器实例
 */
export const createMoorex = <State, Signal, Effect extends HasKey>(
  definition: MoorexDefinition<State, Signal, Effect>,
): Moorex<State, Signal, Effect> => {
  const handlers = new Set<(event: MoorexEvent<State, Signal, Effect>) => void>();
  const running = new Map<string, RunningEffect<Effect>>();
  let state = definition.initialState;
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

  let scheduleSignal: (signal: Signal) => void;

  const startEffect = (effect: Effect) => {
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
      complete: Promise.resolve(), // 临时值，会在下面更新
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

  const reconcileEffects = () => {
    const desired = dedupeByKey(definition.effectsAt(workingState));

    for (const [key, entry] of [...running]) {
      if (!desired.has(key)) {
        running.delete(key);
        cancelRunningEffect(entry, emit);
      }
    }

    for (const [key, effect] of desired) {
      if (running.has(key)) continue;
      startEffect(effect);
    }
  };

  const { schedule } = createSignalQueue<Signal>((signals) => {
    workingState = signals.reduce((current, signal) => {
      emit({ type: 'signal-received', signal });
      return definition.transition(signal)(current);
    }, workingState);

    reconcileEffects();
    state = workingState;
    emit({ type: 'state-updated', state });
  });
  scheduleSignal = schedule;

  const dispatch = (signal: Signal) => {
    scheduleSignal(signal);
  };

  const on = (handler: (event: MoorexEvent<State, Signal, Effect>) => void) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };

  reconcileEffects();

  return {
    dispatch,
    on,
    getState: () => state,
  };
};