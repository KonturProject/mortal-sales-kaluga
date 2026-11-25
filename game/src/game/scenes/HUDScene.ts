import { GameObjects, Scene } from 'phaser';
import { EventBus, GameEvents, FetchErrorPayload } from '../core/EventBus';
import { FinalInfo, GameState } from '../core/GameState';
import { fitCameraToGame } from '../core/Render';
import { GAME, HUD, LIFEBAR, MATCH, POLL } from '../core/Constants';
import { hudText } from '../core/TextStyles';
import { surname } from '../core/Names';
import { percent, rubles } from '../systems/BattleRules';
import { RosterConfig } from '../systems/RosterConfig';
import { AudioSystem } from '../systems/Audio';
import { PairLifebar, SideData } from '../objects/PairLifebar';

const STATUS_X = GAME.WIDTH - 14;

/** Everything over the arena: three rows of plan bars, the next round, the final rating, connection and sound. */
export class HUDScene extends Scene {
    private bars: PairLifebar[] = [];
    private caption!: GameObjects.Text;
    private statusText!: GameObjects.Text;
    private mute!: GameObjects.Text;
    private notice!: GameObjects.Text;
    private rating: GameObjects.Container | null = null;
    /** A demo's rating has no stored result behind it: it stays for its own few seconds. */
    private demoRating = false;
    private failures = 0;
    private lastError = '';
    private lastGoodAt = Date.now();

    constructor() {
        super('HUDScene');
    }

    create() {
        fitCameraToGame(this);
        for (let i = 0; i < MATCH.PAIRS; i++) this.bars.push(new PairLifebar(this, i));
        const below = LIFEBAR.TOP + MATCH.PAIRS * (LIFEBAR.ROW_H + LIFEBAR.ROW_GAP);
        this.caption = this.add.text(GAME.WIDTH / 2, below + 4, '', hudText(15, '#ffe0a8')).setOrigin(0.5, 0).setStroke('#0b1020', 4);
        this.notice = this.add.text(GAME.WIDTH / 2, 330, '', { ...hudText(26, '#ffe89a'), align: 'center', wordWrap: { width: 760 } })
            .setOrigin(0.5).setStroke('#0b1020', 6).setDepth(3000);
        this.statusText = this.add.text(STATUS_X, HUD.STATUS_Y, '', hudText(11, '#8fb8d9', 'Arial, sans-serif')).setOrigin(1, 0.5);
        this.mute = this.add.text(STATUS_X - 170, HUD.STATUS_Y, '', { fontFamily: 'Arial', fontSize: '16px', resolution: GAME.RENDER_SCALE })
            .setOrigin(0.5).setInteractive({ useHandCursor: true });
        this.mute.on('pointerdown', () => {
            AudioSystem.init();
            if (AudioSystem.waitsForClick) AudioSystem.resume();
            else AudioSystem.toggleMute();
            this.time.delayedCall(250, () => this.renderMute());
        });
        this.renderMute();
        this.render();

        const handlers: Array<[string, (...args: never[]) => void]> = [
            [GameEvents.DATA_UPDATED, this.onData],
            [GameEvents.FETCH_ERROR, this.onError],
            [GameEvents.FINAL, this.hideRating],
            [GameEvents.FINAL_END, this.showRating],
        ];
        handlers.forEach(([event, fn]) => EventBus.on(event, fn as never, this));
        const timer = this.time.addEvent({ delay: 20_000, loop: true, callback: () => this.render() });
        this.events.once('shutdown', () => {
            handlers.forEach(([event, fn]) => EventBus.off(event, fn as never, this));
            timer.remove();
        });
    }

    private onData() {
        this.failures = 0;
        this.lastError = '';
        this.lastGoodAt = Date.now();
        if (!GameState.final && !this.demoRating) this.hideRating();
        this.render();
    }

    private onError(payload: FetchErrorPayload) {
        this.failures = payload.consecutiveFailures;
        this.lastError = payload.error;
        this.render();
    }

    private side(slot: string): SideData {
        const leader = GameState.leader(slot);
        const slug = RosterConfig.heroSlugForRop(slot);
        const official = GameState.final?.rating.find(r => r.slot === slot);
        return {
            slug: slug ?? '',
            name: leader?.name ? surname(leader.name) : leader?.code ?? slot,
            color: (slug ? RosterConfig.heroDef(slug)?.color : undefined) ?? '#888888',
            // After the official file the bars show its numbers, not what the leaders entered.
            pct: official?.pct ?? leader?.pct ?? 0, amount: official?.amount ?? leader?.amount ?? 0,
            plan: leader?.plan ?? 0, count: official ? null : leader?.count ?? 0,
        };
    }

    private render() {
        const ready = GameState.hasBaseline;
        this.bars.forEach((bar, i) => {
            const pair = GameState.pairs[i];
            bar.setVisible(ready && !!pair);
            if (pair) bar.setSides(this.side(pair.left), this.side(pair.right));
        });
        this.setText(this.caption, ready ? this.captionText() : '');
        const error = this.lastError.includes('bad_key') ? 'Нет доступа: откройте ссылку экрана из админки.' : 'Нет связи с сервером. Пробую ещё раз…';
        this.setText(this.notice, ready ? '' : this.lastError ? error : 'Загрузка данных…');
        this.renderMute();
        const minutes = Math.floor((Date.now() - this.lastGoodAt) / 60000);
        this.setText(this.statusText, this.failures < POLL.OFFLINE_AFTER_FAILURES ? 'в эфире' : `офлайн ${minutes} мин`);
    }

    private captionText(): string {
        if (GameState.final) return 'ИТОГ ДНЯ';
        const next = GameState.rounds.find(r => r.shares === null);
        if (!next) return `FINAL ROUND: ${GameState.today > GameState.gameDate ? 'СЕГОДНЯ' : 'ЗАВТРА'} В 13:00`;
        const time = new Date(next.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
        return `ROUND ${next.n} В ${time}`;
    }

    private setText(target: GameObjects.Text, text: string) {
        if (target.text !== text) target.setText(text);
    }

    private renderMute() {
        this.setText(this.mute, AudioSystem.isMuted ? '🔇' : AudioSystem.waitsForClick ? '🔇 нажмите для звука' : '🔊');
    }

    /* ------------------------------------------------------------- rating */

    private hideRating() {
        this.rating?.destroy();
        this.rating = null;
    }

    /** The day's rating. `info` comes with a demo; otherwise the stored official result is shown. */
    private showRating(info?: FinalInfo) {
        const final = info ?? GameState.final;
        this.hideRating();
        if (!final) return;
        this.demoRating = info !== undefined && info.id === 0;
        if (this.demoRating) {
            window.setTimeout(() => {
                this.demoRating = false;
                if (!GameState.final) this.hideRating();
            }, 8500);
        }
        const rowH = 46;
        const w = 620;
        const top = 196;
        const x = 60; // left of the champion
        const panel = this.add.graphics();
        panel.fillStyle(0x0b1020, 0.9).fillRoundedRect(x, top, w, 58 + final.rating.length * rowH, 12);
        panel.lineStyle(3, 0xd8b25a, 1).strokeRoundedRect(x, top, w, 58 + final.rating.length * rowH, 12);
        const items: GameObjects.GameObject[] = [panel,
            this.add.text(x + w / 2, top + 28, 'РЕЙТИНГ РГ', hudText(26, '#ffd23a')).setOrigin(0.5).setStroke('#3a2400', 5)];
        final.rating.forEach((row, i) => {
            const y = top + 78 + i * rowH;
            const data = this.side(row.slot);
            const color = i === 0 ? '#ffd23a' : '#ffffff';
            items.push(
                this.add.text(x + 26, y, `${i + 1}`, hudText(22, color)).setOrigin(0, 0.5),
                this.add.image(x + 84, y, `face_${data.slug}`).setDisplaySize(40, 40),
                this.add.text(x + 118, y, data.name, hudText(20, color)).setOrigin(0, 0.5),
                this.add.text(x + 430, y, rubles(row.amount), hudText(15, '#cfe3f5')).setOrigin(1, 0.5),
                this.add.text(x + w - 26, y, percent(row.pct), hudText(22, color)).setOrigin(1, 0.5),
            );
        });
        this.rating = this.add.container(0, 0, items).setDepth(4000).setAlpha(0);
        this.tweens.add({ targets: this.rating, alpha: 1, duration: 500 });
    }
}
