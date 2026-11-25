import { Events } from 'phaser';
import type { FinalInfo } from './GameState';

/** One payment: this leader hits the opponent of the pair. */
export interface StrikePayload { slot: string; amount: number; plan: number }
/** A timed round: the shares of the plan at the bell. */
export interface RoundPayload { n: number; shares: Record<string, number> }
export interface FinalPayload { final: FinalInfo; demo?: boolean }
export interface AdminCommandPayload { type: string; args: Record<string, unknown> }
export interface FetchErrorPayload { consecutiveFailures: number; error: string }

/** The only link between the data layer and the scenes. */
export const EventBus = new Events.EventEmitter();

export const GameEvents = {
    DATA_UPDATED: 'data:updated',
    STRIKE: 'fight:strike',
    ROUND: 'fight:round',
    FINAL: 'fight:final',
    /** ArenaScene -> HUD: the Final Round is over, show the rating. */
    FINAL_END: 'fight:final-end',
    FETCH_ERROR: 'data:fetch-error',
    ADMIN_COMMAND: 'admin:command',
} as const;
