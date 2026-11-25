import { BackendError, callAsGroup } from '../src-admin/api';
import { PaymentEntry, ruDate } from '../src-admin/paymentEntry';
import { percent, rubles, type Payment } from '../src/game/systems/BattleRules';

interface GroupView {
    group: { slot: string; code: string; leader: string | null };
    day: { date: string; amount: number; plan: number; pct: number; editable: boolean; payments: Payment[] };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pinForm = $<HTMLFormElement>('pin-form');
const pinInput = $<HTMLInputElement>('pin');
const panel = $<HTMLDivElement>('panel');
const statusEl = $<HTMLParagraphElement>('status');
const list = $<HTMLDivElement>('rg-list');

/** Kept in memory only for this page's lifetime: never stored, never in a URL. */
let pin = '';
let view: GroupView | null = null;

/** A payment whose answer never came: kept over a reload and sent again with the same id, so it cannot be entered twice. */
const PENDING = 'mortal_sales_kaluga_pending';
interface Pending { slot: string; date: string; amount: number; requestId: string }
const readPending = (): Pending | null => {
    try { return JSON.parse(sessionStorage.getItem(PENDING) ?? 'null'); } catch { return null; }
};

async function resendPending() {
    const p = readPending();
    if (!p || !view || p.slot !== view.group.slot || p.date !== view.day.date) return;
    setStatus(`Досылаю прошлую оплату ${rubles(p.amount)}…`);
    await savePayment(p.amount, p.requestId);
}

const counter = new PaymentEntry(savePayment);
$('rg-counter').append(counter.el);

function setStatus(text: string, kind: 'ok' | 'error' | '' = '') {
    statusEl.textContent = text;
    statusEl.className = kind;
}

function show(v: GroupView) {
    view = v;
    $('title').textContent = v.group.leader || v.group.code;
    $('rg-date').textContent = `${ruDate(v.day.date)} · ${rubles(v.day.amount)} из ${rubles(v.day.plan)} · ${percent(v.day.pct)}`;
    counter.setContext(`${v.group.slot}:${v.day.date}`, v.day.editable);
    list.replaceChildren(...[...v.day.payments].reverse().map(p => {
        const row = document.createElement('div');
        row.className = 'btn-row';
        const time = new Date(p.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
        row.append(`${time} · ${rubles(p.amount)}`);
        if (v.day.editable) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ghost';
            button.textContent = 'Отменить';
            button.addEventListener('click', () => void voidPayment(p, button));
            row.append(button);
        }
        return row;
    }));
}

function showLogin(message = '') {
    pin = '';
    view = null;
    counter.setContext(null);
    panel.hidden = true;
    pinForm.hidden = false;
    $('title').textContent = 'Оплаты группы';
    setStatus(message, message ? 'error' : '');
}

function reportError(err: unknown) {
    if (!(err instanceof BackendError)) {
        console.error(err);
        return setStatus('Что-то пошло не так. Подробности в консоли браузера.', 'error');
    }
    if (err.code === 'invalid_pin') return showLogin('Неверный PIN. Введите его снова.');
    if (err.code === 'locked') return showLogin(`Слишком много неверных попыток. Подождите ${Math.ceil((err.detail?.retryAfterSec ?? 600) / 60)} мин.`);
    if (err.code === 'network') return setStatus('Нет связи с сервером. Нажмите ещё раз: оплата не задвоится.', 'error');
    if (err.code === 'bad_request') {
        const field = err.detail?.field;
        return setStatus(field === 'final' ? 'Итог дня уже подведён, ввод закрыт.' : field === 'date' ? 'Ввод открыт только в день игры. Обновите страницу.' : 'Проверьте сумму оплаты.', 'error');
    }
    setStatus(`Ошибка: ${err.code}`, 'error');
}

async function savePayment(amount: number, requestId: string) {
    if (!pin || !view) return false;
    const current = pin;
    setStatus('Сохраняю…');
    sessionStorage.setItem(PENDING, JSON.stringify({ slot: view.group.slot, date: view.day.date, amount, requestId } satisfies Pending));
    try {
        const res = await callAsGroup<GroupView & { saved: { amount: number } }>('groupAddPayment', current, { date: view.day.date, amount, requestId });
        sessionStorage.removeItem(PENDING);
        if (pin === current) {
            show(res);
            setStatus(`Оплата внесена: ${rubles(res.saved.amount)}. Ваш боец сейчас ударит!`, 'ok');
        }
        return true;
    } catch (err) {
        // Refused by the server: nothing was written. No answer: it may have been, so the payment stays pending.
        if (err instanceof BackendError && err.code !== 'network') sessionStorage.removeItem(PENDING);
        if (pin === current) reportError(err);
        return false;
    }
}

async function voidPayment(payment: Payment, button: HTMLButtonElement) {
    if (!confirm(`Отменить оплату ${rubles(payment.amount)}?`)) return;
    button.disabled = true;
    try {
        show(await callAsGroup<GroupView>('groupVoidPayment', pin, { paymentId: payment.id }));
        setStatus('Оплата отменена.', 'ok');
    } catch (err) {
        button.disabled = false;
        reportError(err);
    }
}

pinForm.addEventListener('submit', async e => {
    e.preventDefault();
    setStatus('Проверяю…');
    const typed = pinInput.value.trim();
    try {
        const res = await callAsGroup<GroupView>('groupLogin', typed);
        pin = typed;
        pinInput.value = '';
        pinForm.hidden = true;
        panel.hidden = false;
        show(res);
        setStatus('');
        await resendPending();
    } catch (err) {
        reportError(err);
    }
});

$('logout').addEventListener('click', () => showLogin());
