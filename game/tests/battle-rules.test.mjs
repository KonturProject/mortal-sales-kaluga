import test from 'node:test';
import assert from 'node:assert/strict';
import { strikeFor, winnerOf, roundSeries, freshPayments, dueRounds, finalOrder, percent, rubles, ROUND_CATCH_UP_MS, ROUND_GRACE_MS, STRIKE_MAX_AGE_MS } from '../src/game/systems/BattleRules.ts';

test('a strike is graded by the share of the own plan', () => {
    assert.equal(strikeFor(19000, 500000).kind, 'light');
    assert.equal(strikeFor(25000, 500000).reaction, 'knockdown');
    assert.equal(strikeFor(50000, 500000).reaction, 'launch');
    assert.equal(strikeFor(50000, 0).kind, 'light', 'no plan yet');
});

test('level shares are a draw, 0:0 at ten in the morning too', () => {
    assert.equal(winnerOf(0, 0), 'draw');
    assert.equal(winnerOf(0.2, 0.1), 'left');
    const level = roundSeries(0, 0);
    assert.equal(level.filter(s => s.side === 'left').length, level.filter(s => s.side === 'right').length);
});

test('the bigger share strikes more often and lands the last blow', () => {
    for (const [l, r] of [[0.5, 0.1], [0.5, 0.45], [0.02, 0.5], [0.3, 0], [0.5, 0.499]]) {
        const series = roundSeries(l, r);
        const winner = winnerOf(l, r);
        const total = side => series.filter(s => s.side === side).reduce((n, s) => n + s.hits, 0);
        assert.ok(total(winner) > total(winner === 'left' ? 'right' : 'left'), `${l} ${r}`);
        assert.equal(series.at(-1).side, winner);
    }
});

test('the first poll is history, later payments strike once', () => {
    const list = [{ id: 'a', slot: 'slot_1', amount: 1, at: 1 }, { id: 'b', slot: 'slot_2', amount: 1, at: 2 }];
    assert.deepEqual(freshPayments(null, list, 10), []);
    assert.deepEqual(freshPayments(new Set(), list, 10 + STRIKE_MAX_AGE_MS), [], 'hours-old blows are never replayed');
    assert.deepEqual(freshPayments(new Set(['a']), list, 10).map(p => p.id), ['b']);
});

test('a round plays once; a display opened late skips the old ones', () => {
    const rounds = [{ n: 1, at: 1000, shares: {} }, { n: 2, at: 9_000_000, shares: {} }, { n: 3, at: 99_000_000, shares: null }];
    const now = 9_000_000 + 60_000;
    assert.deepEqual(dueRounds(rounds, new Set(), now, true).map(r => r.n), [2]);
    assert.deepEqual(dueRounds(rounds, new Set([1, 2]), now, false), []);
    assert.deepEqual(dueRounds(rounds, new Set(), now + ROUND_GRACE_MS, true), []);
    assert.deepEqual(dueRounds(rounds, new Set([1]), now + ROUND_GRACE_MS, false).map(r => r.n), [2], 'an open display catches up');
    assert.deepEqual(dueRounds(rounds, new Set([1]), now + ROUND_CATCH_UP_MS, false), [], 'but not for hours');
});

test('the winner of the final meets the strongest opponent last', () => {
    const rating = ['slot_5', 'slot_1', 'slot_2'].map(slot => ({ slot, amount: 0, plan: 0, pct: 0 }));
    assert.deepEqual(finalOrder(rating), { winner: 'slot_5', opponents: ['slot_2', 'slot_1'] });
    assert.equal(finalOrder([]), null);
});

test('numbers on the screen', () => {
    assert.equal(percent(0.1234), '12,3 %');
    assert.equal(rubles(123456.4), '123 456 ₽');
});
