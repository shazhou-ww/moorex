import { create } from 'mutative';
import type { MoorexEvent, MoorexEventBase, CancelFn } from './types';

/**
 * 创建事件发射器
 *
 * @template State - 机器的状态类型
 * @template Signal - 信号类型
 * @template Effect - Effect 类型
 * @param getEffectCount - 获取当前运行的 effects 数量的函数
 * @returns 事件发射器对象，包含 emit 和 on 方法
 */
export const createEventEmitter = <State, Signal, Effect>(
  getEffectCount: () => number,
) => {
  const handlers = new Set<(event: MoorexEvent<State, Signal, Effect>) => void>();

  const emit = (event: MoorexEventBase<State, Signal, Effect>) => {
    const immutableEvent = create(event, () => {});
    const enriched: MoorexEvent<State, Signal, Effect> = {
      ...immutableEvent,
      effectCount: getEffectCount(),
    };
    for (const handler of [...handlers]) {
      handler(enriched);
    }
  };

  const on = (handler: (event: MoorexEvent<State, Signal, Effect>) => void): CancelFn => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };

  return { emit, on };
};

