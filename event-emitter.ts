import { create } from 'mutative';
import type { CancelFn } from './types';

/**
 * 创建事件发射器
 *
 * @template Event - 事件类型
 * @returns 事件发射器对象，包含 emit 和 on 方法
 */
export const createEventEmitter = <E>() => {
  const handlers = new Set<(event: E) => void>();

  const emit = (event: E) => {
    const immutableEvent = create(event, () => {});
    for (const handler of handlers) {
      handler(immutableEvent);
    }
  };

  const on = (handler: (event: E) => void): CancelFn => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };

  return { emit, on };
};

