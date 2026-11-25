/**
 * The rules of the day as pure functions (no Phaser): tested under plain node, see tests/battle-rules.test.mjs.
 * A share is money / the leader's own plan (0.5 = half of the plan).
 */
export type Side = 'left' | 'right';
export type Reaction = 'none' | 'flinch' | 'stagger' | 'stun' | 'knockdown' | 'launch';
export type StrikeReaction = 'stagger' | 'knockdown' | 'launch';

export interface Payment { id: string; slot: string; amount: number; at: number }
export interface Pair { id: number; left: string; right: string }
export interface RoundInfo { n: number; at: number; shares: Record<string, number> | null }
export interface RatingRow { slot: string; amount: number; plan: number; pct: number }

/** How hard one payment hits. It only changes the picture, never the result. */
export function strikeFor(amount: number, plan: number): { kind: 'light' | 'heavy'; reaction: StrikeReaction } {
    const share = plan > 0 ? amount / plan : 0;
    if (share >= 0.1) return { kind: 'heavy', reaction: 'launch' };
    if (share >= 0.05) return { kind: 'heavy', reaction: 'knockdown' };
    return { kind: 'light', reaction: 'stagger' };
}

/** Shares closer than a hundredth of a percent are a draw. */
const EPSILON = 1e-4;

export function winnerOf(left: number, right: number): Side | 'draw' {
    if (Math.abs(left - right) < EPSILON) return 'draw';
    return left > right ? 'left' : 'right';
}

export interface Series { side: Side; hits: number }

/**
 * Series of blows of one pair in a timed round, in playing order. The bigger share strikes far more (two long series
 * against one or two short ones) and has the last word; level pairs trade equal series.
 */
export function roundSeries(left: number, right: number): Series[] {
    const winner = winnerOf(left, right);
    if (winner === 'draw') return [{ side: 'left', hits: 4 }, { side: 'right', hits: 4 }, { side: 'left', hits: 4 }, { side: 'right', hits: 4 }];
    const loser: Side = winner === 'left' ? 'right' : 'left';
    const gap = Math.min(1, Math.abs(left - right) / Math.max(left, right));
    const strong = 5 + Math.round(gap * 3);
    const rout = gap > 0.6;
    return [
        { side: loser, hits: rout ? 2 : 4 },
        { side: winner, hits: strong - 1 },
        ...(rout ? [] : [{ side: loser, hits: 3 }]),
        { side: winner, hits: strong + 1 },
    ];
}

/** Payments this display has not played yet. `seen` null = first poll: everything is history. */
export function freshPayments(seen: ReadonlySet<string> | null, payments: readonly Payment[], serverNow: number): Payment[] {
    return seen === null ? [] : payments.filter(p => !seen.has(p.id) && serverNow - p.at <= STRIKE_MAX_AGE_MS);
}

/** A display opened this long after the bell still plays the round; later it is history. */
export const ROUND_GRACE_MS = 3 * 60_000;
/** A display that was already open may catch up this long after the bell (the network was down). */
export const ROUND_CATCH_UP_MS = 10 * 60_000;
/** A blow waits in the queue behind a round at most this long; older ones (a hidden tab, a sleeping PC) are history. */
export const STRIKE_MAX_AGE_MS = 150_000;

/** Rounds to play now: open on the server, not played here, not long past. */
export function dueRounds(rounds: readonly RoundInfo[], played: ReadonlySet<number>, serverNow: number, firstPoll: boolean): RoundInfo[] {
    const limit = firstPoll ? ROUND_GRACE_MS : ROUND_CATCH_UP_MS;
    return rounds.filter(r => r.shares !== null && !played.has(r.n) && serverNow - r.at <= limit);
}

/** Final Round: the best share of the plan beats the others one by one, the strongest opponent last. */
export function finalOrder(rating: readonly RatingRow[]): { winner: string; opponents: string[] } | null {
    if (rating.length === 0) return null;
    return { winner: rating[0].slot, opponents: rating.slice(1).map(r => r.slot).reverse() };
}

export const percent = (share: number): string => `${(share * 100).toFixed(1).replace('.', ',')} %`;
export const rubles = (amount: number): string => `${Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
