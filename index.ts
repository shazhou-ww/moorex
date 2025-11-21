import { create, type Immutable } from 'mutative';
import { createSignalQueue } from './signal-queue';
import type {
  HasKey,
  CancelFn,
  EffectInitializer,
  MoorexDefinition,
  MoorexEvent,
  MoorexEventBase,
  Moorex,
  RunningEffect,
} from './types';

// 重新导出类型，保持向后兼容
export type {
  MoorexDefinition,
  MoorexEvent,
  Moorex,
  HasKey,
  CancelFn,
  EffectInitializer,
};

const dedupeByKey = <Effect extends HasKey>(effects: readonly Immutable<Effect>[]): Map<string, Immutable<Effect>> => {
  const byKey = new Map<string, Immutable<Effect>>();
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
 *   runEffect: (effect, state) => ({
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
  // 使用 mutative 确保初始状态的 immutability
  let state: Immutable<State> = definition.initialState;
  let workingState: Immutable<State> = state;

  const emit = (event: MoorexEventBase<State, Signal, Effect>) => {
    // 事件中的 state, signal, effect 字段值已经是 Immutable 类型（调用方已确保）
    // 使用 create 确保整个 event 对象本身也是 immutable 的
    const immutableEvent = create(event, () => {});
    const enriched: MoorexEvent<State, Signal, Effect> = {
      ...immutableEvent,
      effectCount: running.size,
    };
    for (const handler of [...handlers]) {
      handler(enriched);
    }
  };

  let scheduleSignal: (signal: Immutable<Signal>) => void;

  const startEffect = (effect: Immutable<Effect>, state: Immutable<State>) => {
    let initializer: EffectInitializer<Signal>;
    try {
      initializer = definition.runEffect(effect, state);
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

    const guardedDispatch = (signal: Immutable<Signal>) => {
      if (running.get(effect.key) !== entry) return;
      // signal 已经是 Immutable 类型，但为了确保运行时也是 immutable 的
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
    // workingState 已经是 Immutable<State> 类型
    const effects = definition.effectsAt(workingState);
    // effects 已经是 readonly Immutable<Effect>[]，类型系统保证不可变
    const desired = dedupeByKey(effects);

    for (const [key, entry] of [...running]) {
      if (!desired.has(key)) {
        running.delete(key);
        cancelRunningEffect(entry, emit);
      }
    }

    for (const [key, effect] of desired) {
      if (running.has(key)) continue;
      startEffect(effect, workingState);
    }
  };

  const { schedule } = createSignalQueue<Signal>((signals) => {
    // signals 已经是 Immutable<Signal>[]，类型系统保证不可变
    // 使用 reduce 累积状态转换
    workingState = signals.reduce((currentState, signal) => {
      emit({ type: 'signal-received', signal });
      // transition 返回的新 state 已经是 Immutable<State>，类型系统保证不可变
      return definition.transition(signal)(currentState);
    }, workingState);

    reconcileEffects();
    state = workingState;
    emit({ type: 'state-updated', state });
  });
  scheduleSignal = schedule;

  const dispatch = (signal: Immutable<Signal>) => {
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