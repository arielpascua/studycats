/**
 * Tiny typed event bus. Keeps the pure core (timer/economy) ignorant of the scene and the
 * scene ignorant of the DOM: everything talks through here.
 *
 * Deliberately allocation-light — handlers live in a plain array per key, and `emit` walks a
 * copy only when a handler unsubscribes during dispatch.
 */

import type { TimerMode } from './timer';
import type { EnvironmentId } from '../data/environments';
import type { OnlineStatus } from './party-online';

export interface GameEvents {
  /** Timer moved to a new mode. `natural` is false when the user pressed skip. */
  'timer:transition': { from: TimerMode; to: TimerMode; natural: boolean; round: number };
  'timer:start': { mode: TimerMode };
  'timer:pause': { mode: TimerMode };
  'timer:reset': undefined;
  /** Fired once per rendered second while running. */
  'timer:tick': { remainingMs: number; mode: TimerMode; running: boolean };
  /** Last 10 seconds of a running session. */
  'timer:final-countdown': { remainingMs: number };

  'economy:coins': { total: number; delta: number; reason: string };
  'economy:streak': { current: number; frozen: boolean };
  'cat:bond': { catId: string; level: number; leveledUp: boolean };
  'cat:pet': { catId: string };
  'cat:adopted': { catId: string; breedId: string };
  'cat:trick': { catId: string; trick: string };

  'snacks:begin': { environment: EnvironmentId };
  'snacks:end': undefined;
  'snack:eaten': { snackId: string; catId: string };

  'quest:progress': { questId: string; progress: number; goal: number };
  'quest:complete': { questId: string; reward: number };
  'achievement:unlocked': { id: string; title: string; description: string };
  'visitor:appeared': { id: string };
  'visitor:logged': { id: string };

  'env:changed': { environment: EnvironmentId };
  /** The online party moved: a snapshot, a status change or a server error. The panel re-renders. */
  'party:changed': { status: OnlineStatus };
  'settings:changed': undefined;
  'save:written': undefined;
  'toast': { title: string; body?: string; icon?: string; tone?: 'default' | 'reward' | 'gentle' };
}

type Handler<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

export class EventBus {
  private map = new Map<string, Array<Handler<never>>>();

  on<K extends keyof GameEvents>(key: K, fn: Handler<K>): () => void {
    let list = this.map.get(key as string);
    if (!list) {
      list = [];
      this.map.set(key as string, list);
    }
    list.push(fn as Handler<never>);
    return () => this.off(key, fn);
  }

  once<K extends keyof GameEvents>(key: K, fn: Handler<K>): () => void {
    const off = this.on(key, ((payload: GameEvents[K]) => {
      off();
      fn(payload);
    }) as Handler<K>);
    return off;
  }

  off<K extends keyof GameEvents>(key: K, fn: Handler<K>): void {
    const list = this.map.get(key as string);
    if (!list) return;
    const i = list.indexOf(fn as Handler<never>);
    if (i >= 0) list.splice(i, 1);
  }

  emit<K extends keyof GameEvents>(
    key: K,
    ...args: GameEvents[K] extends undefined ? [payload?: undefined] : [payload: GameEvents[K]]
  ): void {
    const list = this.map.get(key as string);
    if (!list || list.length === 0) return;
    // Copy so a handler that unsubscribes itself doesn't shift the array mid-dispatch.
    const snapshot = list.slice();
    for (const fn of snapshot) {
      (fn as (p: unknown) => void)(args[0]);
    }
  }

  clear(): void {
    this.map.clear();
  }

  /** Test helper: how many handlers are registered (leak detection). */
  count(): number {
    let n = 0;
    for (const list of this.map.values()) n += list.length;
    return n;
  }
}

export const bus = new EventBus();
