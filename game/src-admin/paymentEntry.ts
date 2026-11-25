import { newRequestId } from './api';

const MAX_AMOUNT = 100_000_000;

export class PaymentEntry {
    readonly el = document.createElement('div');
    private readonly caption = document.createElement('label');
    private readonly input = document.createElement('input');
    private readonly saveBtn = document.createElement('button');
    private context: string | null = null;
    private requestId: string | null = null;
    private editable = false;
    private busy = false;

    constructor(private readonly onSave: (amount: number, requestId: string) => Promise<boolean>) {
        this.el.className = 'counter';
        this.caption.className = 'counter-caption';
        this.caption.htmlFor = 'day-amount';
        this.caption.textContent = 'Сумма одной оплаты, ₽';
        this.input.id = 'day-amount';
        this.input.type = 'text';
        this.input.inputMode = 'decimal';
        this.input.className = 'amount-input';
        this.input.placeholder = '0,00';
        this.input.addEventListener('input', () => {
            this.requestId = null;
            this.render();
        });
        this.input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !this.saveBtn.disabled) void this.save();
        });
        this.saveBtn.type = 'button';
        this.saveBtn.className = 'primary-btn counter-save';
        this.saveBtn.addEventListener('click', () => void this.save());
        this.el.append(this.caption, this.input, this.saveBtn);
        this.render();
    }

    setContext(context: string | null, editable = true) {
        if (context !== this.context) {
            this.input.value = '';
            this.requestId = null;
        }
        this.context = context;
        this.editable = editable;
        this.render();
    }

    private readInput(): number | null {
        const text = this.input.value.replace(/\s/g, '').replace(',', '.');
        if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
        const amount = Number(text);
        return amount > 0 && amount <= MAX_AMOUNT ? amount : null;
    }

    private async save() {
        const amount = this.readInput();
        if (amount === null || this.saveBtn.disabled) return;
        const id = this.requestId ??= newRequestId();
        this.busy = true;
        this.render();
        try {
            const saved = await this.onSave(amount, id);
            if (saved && this.requestId === id) {
                this.input.value = '';
                this.requestId = null;
            }
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private render() {
        const amount = this.readInput();
        this.input.disabled = this.busy || this.context === null || !this.editable;
        this.saveBtn.disabled = this.input.disabled || amount === null;
        if (this.busy) this.saveBtn.textContent = 'Сохраняю…';
        else if (this.context === null) this.saveBtn.textContent = 'Читаю дату игры…';
        else if (!this.editable) this.saveBtn.textContent = 'Ввод откроется в день игры';
        else this.saveBtn.textContent = 'Внести оплату';
    }
}

export const ruDate = (day: string) => day.split('-').reverse().join('.');
