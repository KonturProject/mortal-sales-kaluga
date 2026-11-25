/**
 * Local stand-in for the Apps Script backend: the real Code.gs on in-memory fake Google services.
 *   npm run mock-backend  -> http://127.0.0.1:8787/exec  (admin PIN 1234, group PINs 111111..666666, key mock-key)
 * GAME_DATE defaults to today, so payments and rounds work at once. Everything is invented and lives in memory.
 */
import fs from 'node:fs';
import http from 'node:http';
import { loadBackend } from '../../apps-script/test/gas-harness.mjs';

const PORT = Number(process.env.PORT) || 8787;
const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const b = loadBackend({ realClock: true, seedSales: false, gameDate: process.env.GAME_DATE || today });
// START=09:59:30 starts the fake server clock at that Moscow time (to watch a round begin by itself).
if (process.env.START) b.advance(Date.parse(`${today}T${process.env.START}+03:00`) - Date.now());
const admin = (action, body = {}) => {
    const res = b.post({ action, pin: '1234', ...body });
    if (!res.ok) throw new Error(action + ': ' + JSON.stringify(res));
    return res;
};
const slots = [1, 2, 3, 4, 5, 6].map(n => `slot_${n}`);
const by = fn => Object.fromEntries(slots.map((s, i) => [s, fn(i)]));
// work/ is not in git: real names, groups and plans may live there for a local look.
const local = fs.existsSync(new URL('../../work/mock-local.json', import.meta.url)) ? JSON.parse(fs.readFileSync(new URL('../../work/mock-local.json', import.meta.url), 'utf8')) : null;
admin('setPlans', { plans: local?.plans ?? by(i => 600000 - i * 30000), gameDate: process.env.GAME_DATE || today });
admin('setGroupCodes', { groupCodes: local?.groupCodes ?? by(i => `Тест_Группа_${i + 1}`) });
admin('setRoster', { leaders: local?.leaders ?? by(i => ['Первый Иван', 'Вторая Анна', 'Третья Ольга', 'Четвёртый Пётр', 'Пятый Олег', 'Шестая Мария'][i]) });
admin('setGroupPins', { pins: by(i => String(i + 1).repeat(6)) });
b.props.set('DISPLAY_KEY', 'mock-key');
[[0, 48000], [2, 21990], [1, 13250], [3, 64000], [4, 30500], [5, 18700], [0, 90500]].forEach(([i, amount], n) =>
    admin('addPayment', { rop: slots[i], date: today, amount, requestId: `mock-payment-${n}` }));

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
http.createServer((req, res) => {
    const send = body => { res.writeHead(200, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (req.method === 'GET') return send(b.get(new URL(req.url ?? '/', 'http://localhost').searchParams.get('key')));
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => send(b.postRaw(raw)));
}).listen(PORT, '127.0.0.1', () => console.log(`Mock backend on http://127.0.0.1:${PORT}/exec`));
