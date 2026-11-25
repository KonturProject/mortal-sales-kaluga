/**
 * Tests of the real Code.gs against fake Google services (see gas-harness.mjs).
 * Run:  node --test apps-script/test/backend.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBackend } from './gas-harness.mjs';

const PIN = '1234';
const DAY = '2026-11-26';
const at = (time, day = DAY) => Date.parse(`${day}T${time}:00+03:00`);
const PLANS = { slot_1: 600000, slot_2: 500000, slot_3: 500000, slot_4: 500000, slot_5: 400000, slot_6: 400000 };

/** A backend on the morning of the game day, with plans, one group PIN and a display key. */
function start(time = '09:00') {
    const b = loadBackend({ startAt: at(time), seedSales: false, gameDate: DAY });
    assert.equal(b.post({ action: 'setPlans', pin: PIN, plans: PLANS, gameDate: DAY }).ok, true);
    assert.equal(b.post({ action: 'setGroupPins', pin: PIN, pins: { slot_1: '111111', slot_2: '222222' } }).ok, true);
    const key = b.post({ action: 'setDisplayKey', pin: PIN }).key;
    let n = 0;
    return {
        b,
        key,
        status: () => b.get(key),
        pay: (groupPin, amount, requestId = `payment-${++n}-test`) =>
            b.post({ action: 'groupAddPayment', groupPin, date: DAY, amount, requestId }),
    };
}

test('the status needs the display key', () => {
    const { b, key } = start();
    assert.equal(b.get().error, 'bad_key');
    assert.equal(b.get('wrong').error, 'bad_key');
    assert.equal(b.get(key).ok, true);
    const fresh = b.post({ action: 'setDisplayKey', pin: PIN }).key;
    assert.equal(b.get(key).error, 'bad_key', 'a new key turns the old links off');
    assert.equal(b.get(fresh).ok, true);
});

test('the public status never carries a PIN or a hash', () => {
    const { status } = start();
    const text = JSON.stringify(status());
    assert.doesNotMatch(text, /111111|222222|1234|\$[0-9a-f]{64}/);
});

test('one payment of a leader is one strike, and the share is counted from the own plan', () => {
    const { status, pay } = start();
    assert.equal(pay('111111', 60000).ok, true);
    assert.equal(pay('222222', 60000).ok, true);
    const s = status();
    assert.deepEqual(s.payments.map(p => [p.slot, p.amount]), [['slot_1', 60000], ['slot_2', 60000]]);
    assert.equal(s.leaders[0].pct, 0.1);
    assert.equal(s.leaders[1].pct, 0.12, 'the same money is a bigger share of a smaller plan');
    assert.equal(s.leaders[0].count, 1);
});

test('a repeated request does not strike twice', () => {
    const { status, pay } = start();
    pay('111111', 60000, 'same-request-id');
    assert.equal(pay('111111', 60000, 'same-request-id').ok, true);
    assert.equal(status().payments.length, 1);
});

test('a leader writes only into the own group and can void only the own payment', () => {
    const { b, status, pay } = start();
    b.post({ action: 'groupAddPayment', groupPin: '111111', rop: 'slot_2', date: DAY, amount: 10, requestId: 'foreign-slot-1' });
    assert.equal(status().payments[0].slot, 'slot_1');
    const id = pay('222222', 5000, 'to-be-voided').saved.id;
    assert.equal(b.post({ action: 'groupVoidPayment', groupPin: '111111', paymentId: id }).error, 'bad_request');
    const res = b.post({ action: 'groupVoidPayment', groupPin: '222222', paymentId: id });
    assert.equal(res.ok, true);
    assert.equal(res.day.amount, 0);
    assert.deepEqual(status().payments.map(p => p.slot), ['slot_1']);
});

test('payments of another date and before the game day are refused', () => {
    const { b } = start();
    const add = date => b.post({ action: 'groupAddPayment', groupPin: '111111', date, amount: 10, requestId: 'date-check-1' });
    assert.equal(add('2026-11-25').error, 'bad_request');
    const early = loadBackend({ startAt: at('18:00', '2026-11-25'), seedSales: false, gameDate: DAY });
    early.post({ action: 'setGroupPins', pin: PIN, pins: { slot_1: '111111' } });
    assert.equal(early.post({ action: 'groupAddPayment', groupPin: '111111', date: DAY, amount: 10, requestId: 'too-early-1' }).error, 'bad_request');
});

test('rounds open at 10, 12 and 15 and count only what was entered by then', () => {
    const { b, status, pay } = start('09:00');
    pay('111111', 60000);
    assert.deepEqual(status().rounds.map(r => r.shares), [null, null, null]);
    assert.deepEqual(status().rounds.map(r => r.at), [at('10:00'), at('12:00'), at('15:00')]);
    b.advance(61 * 60000); // 10:01
    pay('222222', 100000); // after the bell: not in round 1
    const [one, two] = status().rounds;
    assert.equal(one.shares.slot_1, 0.1);
    assert.equal(one.shares.slot_2, 0);
    assert.equal(two.shares, null);
    b.advance(2 * 3600000); // 12:01
    assert.equal(status().rounds[1].shares.slot_2, 0.2);
    assert.equal(status().rounds[0].shares.slot_2, 0, 'a past round never changes');
});

test('pairs: defaults, change, and refusal of a slot used twice', () => {
    const { b, status } = start();
    assert.deepEqual(status().pairs[0], { id: 1, left: 'slot_1', right: 'slot_3' });
    assert.equal(b.post({ action: 'setPairs', pin: PIN, pairs: [['slot_1', 'slot_2'], ['slot_2', 'slot_3']] }).error, 'bad_request');
    assert.equal(b.post({ action: 'setPairs', pin: PIN, pairs: [['slot_6', 'slot_1']] }).ok, true);
    assert.deepEqual(status().pairs, [{ id: 1, left: 'slot_6', right: 'slot_1' }]);
});

const FILE = [
    { date: DAY, amount: 300000, rop: 'slot_1', invoice: '1' },
    { date: DAY, amount: 300000, rop: 'slot_5', invoice: '2' },
];

test('the preview of the official file shows the difference and starts nothing', () => {
    const { b, status, pay } = start();
    pay('111111', 250000);
    const res = b.post({ action: 'importSales', pin: PIN, date: DAY, rows: FILE, dryRun: true });
    assert.equal(res.entered.slot_1, 250000);
    assert.equal(res.official.slot_1, 300000);
    assert.equal(status().final, null);
});

test('the official file starts the Final Round: the best share of the plan wins, payments close', () => {
    const { b, status, pay } = start();
    pay('111111', 123000); // entered by hand: replaced by the file
    pay('222222', 77000); // not in the file at all: becomes 0
    b.advance(28 * 3600000); // 13:00 next day
    assert.equal(b.post({ action: 'importSales', pin: PIN, date: DAY, rows: FILE }).ok, true);
    const final = status().final;
    assert.deepEqual(final.rating.slice(0, 2).map(r => [r.slot, r.pct]), [['slot_5', 0.75], ['slot_1', 0.5]]);
    assert.equal(final.rating.length, 6);
    assert.deepEqual(status().leaders.map(l => l.amount), [300000, 0, 0, 0, 300000, 0], 'only the file counts now');
    assert.equal(b.post({ action: 'groupLogin', groupPin: '222222' }).day.amount, 0, 'the leader sees the official number too');
    assert.equal(pay('111111', 10).error, 'bad_request');
    assert.equal(b.post({ action: 'clearFinal', pin: PIN }).ok, true);
    assert.equal(status().final, null);
    assert.equal(pay('111111', 10).ok, true);
});

test('the same file again is the same final; a corrected one is a new final', () => {
    const { b, status } = start();
    b.advance(28 * 3600000);
    const send = rows => b.post({ action: 'importSales', pin: PIN, date: DAY, rows });
    send(FILE);
    const id = status().final.id;
    b.advance(60_000);
    send([...FILE].reverse());
    assert.equal(status().final.id, id);
    b.advance(60_000);
    send([FILE[0]]);
    assert.notEqual(status().final.id, id);
});

test('a return (negative line) lowers the sum; without plans the file is refused', () => {
    const { b, status } = start();
    b.post({ action: 'importSales', pin: PIN, date: DAY, rows: [...FILE, { date: DAY, amount: -50000, rop: 'slot_1', invoice: '3' }] });
    assert.equal(status().final.official.slot_1, 250000);
    const bare = loadBackend({ startAt: at('13:00'), seedSales: false, gameDate: DAY });
    assert.equal(bare.post({ action: 'importSales', pin: PIN, date: DAY, rows: FILE }).field, 'plans');
});

test('a rehearsal final of another date does not close the game day', () => {
    const { b, status, pay } = start();
    b.post({ action: 'importSales', pin: PIN, date: DAY, rows: FILE });
    assert.equal(pay('111111', 10).error, 'bad_request');
    b.advance(24 * 3600000);
    b.post({ action: 'setPlans', pin: PIN, plans: PLANS, gameDate: '2026-11-27' });
    assert.equal(status().final, null);
    assert.equal(b.post({ action: 'groupAddPayment', groupPin: '111111', date: '2026-11-27', amount: 10, requestId: 'next-day-pay-1' }).ok, true);
});

test('the official file rejects rows of another date', () => {
    const { b } = start();
    const rows = [{ ...FILE[0], date: '2026-11-25' }];
    assert.equal(b.post({ action: 'importSales', pin: PIN, date: DAY, rows }).error, 'bad_request');
});

test('admin actions need the PIN; fifteen wrong ones lock for two minutes', () => {
    const { b } = start();
    for (const action of ['setPlans', 'setPairs', 'setDisplayKey', 'importSales', 'clearFinal', 'voidPayment']) {
        assert.equal(b.post({ action, pin: '0000' }).error, 'invalid_pin');
    }
    for (let i = 0; i < 9; i++) b.post({ action: 'login', pin: '0000' });
    assert.equal(b.post({ action: 'login', pin: PIN }).error, 'locked');
    b.advance(121_000);
    assert.equal(b.post({ action: 'login', pin: PIN }).ok, true);
});

test('one leader mistyping does not shut the others out, and a guesser is not forgiven by their sign-ins', () => {
    const { b, pay } = start();
    for (let i = 0; i < 10; i++) assert.equal(b.post({ action: 'groupLogin', groupPin: '000000' }).error, 'invalid_pin');
    assert.equal(pay('111111', 1000).ok, true);
    let locked = false;
    for (let i = 0; i < 25 && !locked; i++) {
        locked = b.post({ action: 'groupLogin', groupPin: '000000' }).error === 'locked';
        if (!locked) b.post({ action: 'groupLogin', groupPin: '222222' });
    }
    assert.equal(locked, true);
    b.advance(121_000);
    assert.equal(pay('111111', 1000).ok, true);
});

test('a status is built once per few seconds, and a write shows up at once', () => {
    const { b, key, status, pay } = start();
    status();
    const original = b.salesSheet().getRange;
    let reads = 0;
    b.salesSheet().getRange = function (...args) { reads++; return original.apply(this, args); };
    for (let i = 0; i < 10; i++) assert.equal(b.get(key).ok, true);
    assert.equal(reads, 0, 'served from the cache');
    assert.equal(b.get('wrong').error, 'bad_key', 'the cache does not bypass the key');
    b.salesSheet().getRange = original;
    pay('111111', 1000);
    assert.equal(status().payments.length, 1);
    const before = status().serverNow;
    b.advance(3000);
    assert.equal(status().serverNow - before, 3000, 'the clock is never cached');
});

test('a payment a blink before the bell is in, and the result opens only after the writes settled', () => {
    const { b, status, pay } = start('09:59');
    b.advance(59_900);
    pay('111111', 60000);
    b.advance(1000); // 10:00:00.9
    assert.equal(status().rounds[0].shares, null);
    b.advance(6000);
    assert.equal(status().rounds[0].shares.slot_1, 0.1);
});

test('admin commands: hit, round and final demos are queued; unknown ones are refused', () => {
    const { b, status } = start();
    assert.equal(b.post({ action: 'command', pin: PIN, type: 'hit', args: { rop: 'slot_1', amount: 70000 } }).ok, true);
    assert.equal(b.post({ action: 'command', pin: PIN, type: 'round', args: { n: 2 } }).ok, true);
    assert.equal(b.post({ action: 'command', pin: PIN, type: 'round', args: { n: 4 } }).error, 'bad_request');
    assert.equal(b.post({ action: 'command', pin: PIN, type: 'growl' }).error, 'bad_request');
    assert.deepEqual(status().commands.map(c => c.type), ['hit', 'round']);
});
