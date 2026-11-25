import { BackendError, callBackend, newRequestId, type AdminState, type ImportPreview } from './api';
import { badge, chip, clear, h, section, select, table } from './dom';
import { parsePaymentsFile, PaymentsFileError, type ParsedPayments } from './paymentsFile';
import ropMapping from '../src/game/config/ropMapping.json';
import { percent, rubles } from '../src/game/systems/BattleRules';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pinForm = $<HTMLFormElement>('pin-form');
const pinInput = $<HTMLInputElement>('pin');
const panel = $<HTMLDivElement>('panel');
const nav = $<HTMLElement>('tab-nav');
const content = $<HTMLDivElement>('tab-content');
const statusEl = $<HTMLParagraphElement>('status');

/** The fighter of each slot: shown next to the name, so nobody gets someone else's face. */
const face = (slot: string) => h('img', { src: `assets/sprites/${(ropMapping.mapping as Record<string, string>)[slot]}.png`, height: 64, alt: '' });

const SLOTS = ['slot_1', 'slot_2', 'slot_3', 'slot_4', 'slot_5', 'slot_6'];

/** Kept in memory only for this page's lifetime: never stored, never in a URL. */
let pin = '';
let state: AdminState;
let active = 'day';
/** One request id per preview: pressing again after a lost answer is the same request. */
let preview: { file: ParsedPayments; result: ImportPreview; requestId: string } | null = null;

function setStatus(text: string, kind: 'ok' | 'error' | '' = '') {
    statusEl.textContent = text;
    statusEl.className = kind;
}

function showLogin(message = '') {
    pin = '';
    panel.hidden = true;
    pinForm.hidden = false;
    clear(nav);
    clear(content);
    setStatus(message, message ? 'error' : '');
}

const FIELDS: Record<string, string> = {
    plans: 'планы (у каждого РГ должен быть план больше нуля)', gameDate: 'дата игры', date: 'дата (запись открыта в день игры и позже)', pairs: 'пары (каждый РГ только в одной паре)',
    groupCodes: 'коды групп', leaders: 'имена РГ', pins: 'PIN (6–12 цифр)', pins_duplicate: 'PIN совпадает с другим PIN', rows: 'строки файла', newPin: 'новый PIN (4–12 цифр)',
    newPin_same: 'новый PIN совпадает со старым', final: 'итог уже загружен', paymentId: 'оплата не найдена',
};

function report(err: unknown) {
    if (err instanceof PaymentsFileError) return setStatus(err.message, 'error');
    if (!(err instanceof BackendError)) {
        console.error(err);
        return setStatus('Что-то пошло не так. Подробности в консоли браузера.', 'error');
    }
    if (err.code === 'invalid_pin') return showLogin('Неверный PIN. Введите его снова.');
    if (err.code === 'locked') return showLogin(`Слишком много неверных попыток. Подождите ${Math.ceil((err.detail?.retryAfterSec ?? 600) / 60)} мин.`);
    if (err.code === 'network') return setStatus('Не удалось связаться с сервером.', 'error');
    if (err.code === 'demo') return setStatus('Бэкенд не подключён: укажите appsScriptUrl в config.json.', 'error');
    if (err.code === 'bad_request') return setStatus(`Проверьте: ${FIELDS[err.detail?.field ?? ''] ?? err.detail?.field ?? 'данные'}.`, 'error');
    setStatus(`Ошибка сервера: ${err.code}`, 'error');
}

/** Runs an action with the button disabled; afterwards the data is read again. */
async function run(button: HTMLButtonElement | null, fn: () => Promise<string | void>, reload = true) {
    if (button) button.disabled = true;
    setStatus('Выполняю…');
    try {
        const message = await fn();
        if (reload) await load();
        setStatus(message ?? 'Готово.', 'ok');
    } catch (err) {
        report(err);
    } finally {
        if (button) button.disabled = false;
    }
}

const call = <T extends object = Record<string, never>>(action: string, payload: Record<string, unknown> = {}) => callBackend<T>(action, pin, payload);

async function load() {
    state = await call<AdminState>('listSales', { limit: 200 });
    render();
}

const label = (slot: string) => {
    const name = state.settings.leaders[slot];
    return name ? `${name} · ${state.settings.groupCodes[slot]}` : state.settings.groupCodes[slot];
};
const options = () => SLOTS.map(value => ({ value, label: label(value) }));

function action(text: string, fn: () => Promise<string | void>, className = 'primary-btn', reload = true) {
    const button = h('button', { type: 'button', className }, text);
    button.addEventListener('click', () => void run(button, fn, reload));
    return button;
}

/* --------------------------------------------------------------- day */

function dayTab() {
    const s = state.status;
    const pairs = s.pairs.map(p => {
        const [l, r] = [p.left, p.right].map(slot => s.leaders.find(x => x.slot === slot)!);
        return [label(p.left), percent(l.pct), percent(r.pct), label(p.right), l.pct === r.pct ? badge('ничья') : badge(`впереди: ${l.pct > r.pct ? label(p.left) : label(p.right)}`, 'ok')];
    });
    const payments = [...s.payments].reverse().slice(0, 40).map(p => [
        new Date(p.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }), label(p.slot), rubles(p.amount),
        s.final ? '' : action('Отменить', async () => {
            if (!confirm(`Отменить оплату ${rubles(p.amount)}: ${label(p.slot)}?`)) return 'Ничего не изменено.';
            await call('voidPayment', { rop: p.slot, paymentId: p.id });
            return 'Оплата отменена.';
        }, 'ghost'),
    ]);
    return [
        h('div', { className: 'chips' }, chip('Дата игры', s.gameDate), chip('Оплат', String(s.payments.length)),
            chip('Сумма', rubles(s.leaders.reduce((a, l) => a + l.amount, 0))), chip('Итог', s.final ? 'загружен' : 'нет')),
        section('Пары сейчас', table([{ text: 'РГ' }, { text: '% плана', num: true }, { text: '% плана', num: true }, { text: 'РГ' }, { text: '' }], pairs)),
        section('Оплаты', table([{ text: 'Время' }, { text: 'РГ' }, { text: 'Сумма', num: true }, { text: '' }], payments)),
        action('Обновить', async () => 'Данные обновлены.', 'ghost'),
    ];
}

/* ------------------------------------------------------------- import */

function importTab() {
    const file = h('input', { type: 'file', accept: '.xlsx' });
    const out = h('div', {});
    const read = action('Прочитать', async () => {
        const picked = file.files?.[0];
        if (!picked) throw new PaymentsFileError('Выберите файл .xlsx.');
        const parsed = await parsePaymentsFile(picked, state.status.gameDate, state.settings.groupCodes);
        if (parsed.rows.length === 0) throw new PaymentsFileError(`В файле нет оплат наших групп за ${state.status.gameDate}.`);
        preview = { file: parsed, result: await call<ImportPreview>('importSales', { date: parsed.date, rows: parsed.rows, dryRun: true }), requestId: newRequestId() };
        showPreview();
        return 'Проверьте таблицу. Пока ничего не записано.';
    }, 'primary-btn', false);

    const showPreview = () => {
        clear(out);
        if (!preview) return;
        const { file: f, result } = preview;
        out.append(
            h('p', { className: 'hint' }, `Счетов за день: ${f.rows.length}. Строк других дат: ${f.outsideDate}. Минусовых строк (возвраты): ${f.negative}. Не прочитано: ${f.unreadable}. Сумма всех строк файла: ${rubles(f.linesTotal)}${f.fileTotal === null ? '' : `, «Сумма заказа» в файле: ${rubles(f.fileTotal)}`}.`),
            ...(f.foreign.length ? [h('p', { className: 'hint' }, `Другие группы за день (не учтены): ${f.foreign.map(x => x.group).join(', ')}`)] : []),
            h('p', { className: 'hint' }, 'После загрузки файл полностью заменит внесённое РГ: на экранах и в рейтинге останутся только детальные данные. Чего нет в файле, то не считается.'),
            table([{ text: 'РГ' }, { text: 'Внесли РГ', num: true }, { text: 'Детальные данные', num: true }, { text: 'Разница', num: true }, { text: '% плана', num: true }],
                result.rating.map(r => [label(r.slot), rubles(result.entered[r.slot]), rubles(r.amount), rubles(r.amount - result.entered[r.slot]), percent(r.pct)])),
            action('Загрузить и запустить Final Round', async () => {
                if (!preview || !confirm(`Запустить Final Round на всех экранах? Победитель: ${label(preview.result.rating[0].slot)}. Ввод оплат закроется.`)) return 'Ничего не изменено.';
                await call('importSales', { date: preview.file.date, rows: preview.file.rows, requestId: preview.requestId });
                preview = null;
                return 'Итог загружен. Final Round начнётся на экранах в течение 15 секунд.';
            }),
        );
    };
    const parts = [section('Детальные данные по оплаченным счетам',
        h('p', { className: 'hint' }, `Берём только строки за ${state.status.gameDate} и наши шесть групп.`), file, read, out)];
    if (state.status.final) {
        parts.push(section('Итог уже загружен', action('Отменить итог', async () => {
            if (!confirm('Убрать итог? Экраны вернутся к дневному бою, ввод оплат откроется.')) return 'Ничего не изменено.';
            await call('clearFinal');
            return 'Итог снят.';
        }, 'ghost')));
    }
    return parts;
}

/* ------------------------------------------------------------- pairs */

function pairsTab() {
    const selects = [0, 1, 2].map(i => ['left', 'right'].map((side, k) =>
        select(options(), state.status.pairs[i]?.[side as 'left' | 'right'] ?? SLOTS[i * 2 + k])));
    return [section('Кто с кем дерётся', ...selects.map(([l, r], i) => h('div', { className: 'btn-row' }, `${i + 1}`, l, 'VS', r)),
        action('Сохранить пары', async () => {
            await call('setPairs', { pairs: selects.map(([l, r]) => [l.value, r.value]) });
            return 'Пары сохранены.';
        }))];
}

/* ----------------------------------------------------- leaders and plans */

function leadersTab() {
    const date = h('input', { type: 'date', value: state.status.gameDate });
    const rows = SLOTS.map(slot => ({
        slot,
        name: h('input', { type: 'text', value: state.settings.leaders[slot] ?? '', placeholder: 'Фамилия Имя' }),
        code: h('input', { type: 'text', value: state.settings.groupCodes[slot] ?? '' }),
        plan: h('input', { type: 'text', inputMode: 'numeric', value: String(state.settings.plans[slot] ?? '') }),
    }));
    return [section('РГ, группы и планы', h('label', {}, 'Дата игры'), date,
        table([{ text: 'Боец' }, { text: 'Имя РГ' }, { text: 'Группа, как в файле' }, { text: 'План, ₽' }], rows.map(r => [face(r.slot), r.name, r.code, r.plan])),
        action('Сохранить', async () => {
            const take = (key: 'name' | 'code' | 'plan') => Object.fromEntries(rows.map(r => [r.slot, r[key].value.trim()]));
            const plans = Object.fromEntries(rows.map(r => [r.slot, Number(r.plan.value.replace(/\s/g, '').replace(',', '.'))]));
            await call('setPlans', { plans, gameDate: date.value });
            await call('setGroupCodes', { groupCodes: take('code') });
            await call('setRoster', { leaders: take('name') });
            return 'Сохранено.';
        }))];
}

/* ------------------------------------------------------------- demos */

function demoTab() {
    const who = select(options(), SLOTS[0]);
    const amount = h('input', { type: 'text', inputMode: 'numeric', value: '20000' });
    const demo = (text: string, type: string, args: () => Record<string, unknown>) =>
        action(text, async () => {
            await call('command', { type, args: args(), requestId: newRequestId() });
            return 'Отправлено на экраны.';
        }, 'ghost', false);
    return [section('Показать на экранах (данные не меняются)',
        h('div', { className: 'btn-row' }, who, amount, demo('Удар', 'hit', () => ({ rop: who.value, amount: Number(amount.value.replace(/\s/g, '')) }))),
        h('div', { className: 'btn-row' }, ...[1, 2, 3].map(n => demo(`Round ${n}`, 'round', () => ({ n }))), demo('Final Round', 'final', () => ({})),
            demo('Конфетти', 'confetti', () => ({}))))];
}

/* ------------------------------------------------------------- access */

function accessTab() {
    const out = h('div', {});
    const who = select(options(), SLOTS[0]);
    const newPin = h('input', { type: 'password', inputMode: 'numeric', autocomplete: 'new-password', placeholder: 'новый PIN администратора' });
    const random = () => String(10_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90_000_000));
    const showPins = (pins: Record<string, string>) => {
        clear(out);
        out.append(h('p', { className: 'hint' }, 'PIN показаны один раз. Передайте каждому РГ лично.'),
            table([{ text: 'РГ' }, { text: 'PIN' }], Object.entries(pins).map(([slot, p]) => [label(slot), h('strong', {}, p)])));
    };
    const setPins = async (slots: string[]) => {
        const pins = Object.fromEntries(slots.map(slot => [slot, random()]));
        await call('setGroupPins', { pins });
        showPins(pins);
        return 'PIN созданы.';
    };
    return [
        section('PIN руководителей групп', h('p', { className: 'hint' }, `Страница РГ: ${new URL('rg.html', location.href).href}`),
            action('Создать PIN всем', async () => (confirm('Старые PIN перестанут работать. Продолжить?') ? setPins(SLOTS) : 'Ничего не изменено.'), 'primary-btn', false),
            h('div', { className: 'btn-row' }, who, action('Новый PIN одному', () => setPins([who.value]), 'ghost', false)), out),
        section('Ссылка для экранов', action('Создать ключ экрана', async () => {
            if (!confirm('Старые ссылки экранов перестанут работать. Продолжить?')) return 'Ничего не изменено.';
            const { key } = await call<{ key: string }>('setDisplayKey');
            clear(out);
            out.append(h('p', {}, 'Откройте один раз на каждом экране:'), h('input', { type: 'text', readOnly: true, value: `${new URL('.', location.href).href}#key=${key}` }));
            return 'Ключ создан.';
        }, 'ghost', false)),
        section('PIN администратора', newPin, action('Сменить', async () => {
            await call('changePin', { newPin: newPin.value });
            pin = newPin.value;
            newPin.value = '';
            return 'PIN изменён.';
        }, 'ghost', false)),
    ];
}

const TABS: [string, string, () => (Node | string)[]][] = [
    ['day', 'День', dayTab], ['import', 'Импорт', importTab], ['pairs', 'Пары', pairsTab],
    ['leaders', 'РГ и планы', leadersTab], ['demo', 'Анимации', demoTab], ['access', 'Доступ', accessTab],
];

function render() {
    clear(nav);
    for (const [id, title] of TABS) {
        const button = h('button', { type: 'button', className: id === active ? 'tab-btn active' : 'tab-btn' }, title);
        button.addEventListener('click', () => { active = id; setStatus(''); render(); });
        nav.append(button);
    }
    clear(content);
    content.append(...(TABS.find(t => t[0] === active) ?? TABS[0])[2]());
}

pinForm.addEventListener('submit', async e => {
    e.preventDefault();
    setStatus('Проверяю…');
    pin = pinInput.value;
    try {
        await load();
    } catch (err) {
        report(err);
        return;
    }
    pinInput.value = '';
    pinForm.hidden = true;
    panel.hidden = false;
    setStatus('');
});

$('logout').addEventListener('click', () => showLogin());
