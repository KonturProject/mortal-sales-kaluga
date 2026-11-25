import type { Pair, Payment, RatingRow, RoundInfo } from '../systems/BattleRules';

/** One group leader (РГ) as the backend sees them. Names, plans and money come only from the backend. */
export interface LeaderStatus {
    slot: string;
    code: string;
    name: string;
    plan: number;
    amount: number;
    /** amount / plan: the number every fight is decided by. */
    pct: number;
    /** Payments entered today. */
    count: number;
}

/** The official result of the day (the detail file was imported). */
export interface FinalInfo {
    id: number;
    at: number;
    date: string;
    official: Record<string, number>;
    rating: RatingRow[];
}

export interface BackendCommand {
    id: number;
    type: string;
    args: Record<string, unknown>;
    issuedAt: number;
}

export interface StatusResponse {
    ok: boolean;
    gameDate: string;
    today: string;
    leaders: LeaderStatus[];
    pairs: Pair[];
    payments: Payment[];
    rounds: RoundInfo[];
    final: FinalInfo | null;
    commands?: BackendCommand[];
    serverNow: number;
    lastUpdated: string;
    error?: string;
}

class GameStateStore {
    gameDate = '';
    today = '';
    leaders: LeaderStatus[] = [];
    pairs: Pair[] = [];
    rounds: RoundInfo[] = [];
    final: FinalInfo | null = null;
    /** true once a poll has landed: the first one is a baseline, never played as fights */
    hasBaseline = false;

    applyStatus(status: StatusResponse) {
        this.gameDate = status.gameDate;
        this.today = status.today;
        this.leaders = status.leaders;
        this.pairs = [...status.pairs].sort((a, b) => a.id - b.id);
        this.rounds = status.rounds;
        this.final = status.final;
        this.hasBaseline = true;
    }

    leader(slot: string): LeaderStatus | undefined {
        return this.leaders.find(l => l.slot === slot);
    }
}

export const GameState = new GameStateStore();
