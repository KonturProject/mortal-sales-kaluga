/**
 * Reads a CRM export «Детальные данные по оплаченным счетам» (.xlsx) in the browser. Only the date of payment, the
 * amount, the group and the invoice number are taken; clients, INNs and products never leave this page.
 *
 * The layout drifts between exports (header in row 1 or row 3, a title above it), so the header row is found by
 * the column names. One line = one item of a paid invoice; the items of one invoice are added up into one row for the configured game date.
 * The last line «Сумма заказа» holds the file's own total — used to check that nothing was lost on the way.
 */

/** One payment as it goes to the sheet: one invoice of one group on one day. */
export interface ImportRow {
    date: string;   // 'yyyy-MM-dd'
    amount: number;
    rop: string;    // stable group slot
    invoice: string;
}

export interface ParsedPayments {
    rows: ImportRow[];
    date: string;
    outsideDate: number;
    /** Payment lines read (all groups) and their sum — compared with `fileTotal`. */
    lines: number;
    linesTotal: number;
    /** The «Сумма заказа» line, if the file has one. */
    fileTotal: number | null;
    /** Groups that are not ours: not imported, only reported. */
    foreign: { group: string; lines: number; amount: number }[];
    /** Lines that could not be read (no date, no amount). */
    unreadable: number;
    /** Returns of the game date (negative lines): they lower the group's sum. */
    negative: number;
}

export class PaymentsFileError extends Error {}

const fold = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
const pad = (n: number) => String(n).padStart(2, '0');
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A date cell as 'yyyy-MM-dd': an Excel serial number, «01.10.2026», «2026-10-01» or a Date; '' if unreadable. */
function toDay(value: unknown, parseSerial: (n: number) => { y: number; m: number; d: number } | null): string {
    if (typeof value === 'number' && value > 0) {
        const p = parseSerial(value);
        return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : '';
    }
    if (value instanceof Date && !isNaN(value.getTime())) return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    const text = String(value ?? '').trim();
    let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text);
    if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** An amount cell: a number, or text like «21 990,50»; NaN if it is not one. */
function toAmount(value: unknown): number {
    if (typeof value === 'number') return value;
    const text = String(value ?? '').replace(/[\s ₽]/g, '').replace(',', '.');
    return text === '' ? NaN : Number(text);
}

/** What the sheet accepts as an invoice number (see apps-script/Code.gs, importSales). */
const cleanInvoice = (value: unknown) => String(value ?? '').trim().replace(/[^0-9A-Za-zА-Яа-яЁё/_-]/g, '').slice(0, 30);

export async function parsePaymentsFile(file: File, date: string, groupCodes: Record<string, string>): Promise<ParsedPayments> {
    // Loaded on demand: the reader is big, and only this tab needs it.
    const XLSX = await import('xlsx');

    // Groups are matched by their full name exactly: the numbers are not contiguous and short forms would mix them up.
    const slots = new Map(Object.entries(groupCodes).map(([slot, code]) => [fold(code), slot]));

    let grid: unknown[][];
    try {
        const book = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: false, dense: true });
        const sheet = book.Sheets[book.SheetNames[0]];
        grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false });
    } catch {
        throw new PaymentsFileError('Не получилось прочитать файл: это не Excel-файл (.xlsx) или он повреждён.');
    }

    let header = -1;
    let col = { date: -1, group: -1, amount: -1, invoice: -1 };
    for (let r = 0; r < Math.min(20, grid.length) && header < 0; r++) {
        const cells = (grid[r] ?? []).map(fold);
        const found = {
            date: cells.indexOf('дата оплаты'),
            group: cells.indexOf('группа'),
            amount: cells.indexOf('сумма'),
            invoice: cells.findIndex(c => c === '№ счета' || c === 'номер счета'),
        };
        if (found.date >= 0 && found.group >= 0 && found.amount >= 0) {
            header = r;
            col = found;
        }
    }
    if (header < 0) {
        throw new PaymentsFileError('В файле нет колонок «Дата оплаты», «Группа» и «Сумма». Нужна выгрузка «Детальные данные по оплаченным счетам».');
    }

    const parseSerial = (n: number) => {
        const p = XLSX.SSF.parse_date_code(n);
        return p && p.y > 1900 ? { y: p.y, m: p.m, d: p.d } : null;
    };

    const payments = new Map<string, ImportRow>();
    const foreign = new Map<string, { group: string; lines: number; amount: number }>();
    let fileTotal: number | null = null;
    let lines = 0;
    let linesTotal = 0;
    let unreadable = 0;
    let outsideDate = 0;
    let negative = 0;

    for (let r = header + 1; r < grid.length; r++) {
        const row = grid[r] ?? [];
        if (row.some(c => fold(c).startsWith('сумма заказа'))) {
            const total = toAmount(row[col.amount]);
            if (isFinite(total)) fileTotal = total;
            continue;
        }
        const group = String(row[col.group] ?? '').trim();
        const rawDate = row[col.date];
        const rawAmount = row[col.amount];
        if (!group && (rawDate === null || rawDate === '') && (rawAmount === null || rawAmount === '')) continue;

        const day = toDay(rawDate, parseSerial);
        const amount = toAmount(rawAmount);
        if (!day || !isFinite(amount) || amount === 0 || !group) {
            unreadable++;
            continue;
        }
        lines++;
        linesTotal += amount;
        if (day !== date) {
            outsideDate++;
            continue;
        }

        if (amount < 0) negative++;
        const code = slots.get(fold(group));
        if (!code) {
            const entry = foreign.get(group) ?? { group, lines: 0, amount: 0 };
            entry.lines++;
            entry.amount += amount;
            foreign.set(group, entry);
            continue;
        }

        const invoice = col.invoice >= 0 ? cleanInvoice(row[col.invoice]) : '';
        // The items of one invoice become one payment; a line without an invoice number stays on its own.
        const key = invoice ? `${invoice}|${day}|${code}` : `#${r}`;
        const earlier = payments.get(key);
        if (earlier) earlier.amount += amount;
        else payments.set(key, { date: day, amount, rop: code, invoice });
    }

    if (lines === 0) throw new PaymentsFileError('В файле не нашлось ни одной оплаты с датой и суммой.');

    const rows = [...payments.values()].map(p => ({ ...p, amount: round2(p.amount) })).filter(p => p.amount !== 0);
    return {
        rows,
        date,
        outsideDate,
        lines,
        linesTotal: round2(linesTotal),
        fileTotal,
        foreign: [...foreign.values()].sort((a, b) => b.amount - a.amount),
        unreadable,
        negative,
    };
}
