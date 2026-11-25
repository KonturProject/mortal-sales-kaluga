import * as Phaser from 'phaser';
import { Scene } from 'phaser';
import { EventBus, GameEvents, AdminCommandPayload, FinalPayload, RoundPayload, StrikePayload } from '../core/EventBus';
import { GameState } from '../core/GameState';
import { fitCameraToGame } from '../core/Render';
import { ARENA, CHAMPION_X, FIGHT, GAME, MATCH } from '../core/Constants';
import { sleep, wallSleep } from '../core/Async';
import { RosterConfig } from '../systems/RosterConfig';
import { DataPollingService } from '../systems/DataPollingService';
import { FightDirector } from '../systems/FightDirector';
import { finalOrder, percent, ROUND_CATCH_UP_MS, rubles, STRIKE_MAX_AGE_MS } from '../systems/BattleRules';
import { surname } from '../core/Names';
import { ArenaLight } from '../systems/ArenaLight';
import { Fighter } from '../objects/Fighter';
import { emitConfettiBurst, emitTitle, flashScreen } from '../systems/Fx';
import { AudioSystem } from '../systems/Audio';

/**
 * Three lanes, one per pair. What happens is decided upstream; here it only plays: payments, timed rounds and the
 * Final Round go through one queue, strictly one after another.
 */
export class ArenaScene extends Scene {
    private director!: FightDirector;
    private light!: ArenaLight;
    readonly fighters = new Map<string, Fighter>();
    private seated = '';
    private queueTail: Promise<void> = Promise.resolve();
    private queued = 0;
    private finalShown = false;

    constructor() {
        super('ArenaScene');
    }

    create() {
        fitCameraToGame(this);
        this.cameras.main.setBackgroundColor('#08090f');
        if (this.textures.exists('bg_arena')) {
            this.add.image(GAME.WIDTH / 2, GAME.HEIGHT / 2, 'bg_arena').setDisplaySize(GAME.WIDTH, GAME.HEIGHT).setDepth(-10);
        }
        for (const slot of RosterConfig.ropCodes()) {
            const slug = RosterConfig.heroSlugForRop(slot);
            const def = slug ? RosterConfig.heroDef(slug) : undefined;
            if (def) this.fighters.set(slot, new Fighter(this, def, slot).setVisible(false) as Fighter);
        }
        this.light = new ArenaLight(this, [...this.fighters.values()]);
        this.director = new FightDirector(this, this.light);

        const handlers: Array<[string, (...args: never[]) => void]> = [
            [GameEvents.STRIKE, this.onStrike],
            [GameEvents.ROUND, this.onRound],
            [GameEvents.FINAL, this.onFinal],
            [GameEvents.DATA_UPDATED, this.sync],
            [GameEvents.ADMIN_COMMAND, this.onAdminCommand],
        ];
        handlers.forEach(([event, fn]) => EventBus.on(event, fn as never, this));
        this.events.once('shutdown', () => handlers.forEach(([event, fn]) => EventBus.off(event, fn as never, this)));
        this.sync();
        void DataPollingService.start();
    }

    /* ------------------------------------------------------------- state */

    /** Puts everyone where the data says. Skipped while something plays, repeated when the queue is empty. */
    private sync() {
        if (this.queued > 0 || !GameState.hasBaseline) return;
        if (GameState.final && !this.finalShown) {
            // Opened after the final: show the verdict, do not replay it.
            this.finalShown = true;
            this.showVerdict();
        } else if (!GameState.final && this.finalShown) {
            this.finalShown = false;
            this.seated = '';
        }
        if (!this.finalShown) this.seatPairs();
    }

    private seatPairs() {
        const signature = GameState.pairs.map(p => `${p.left}/${p.right}`).join('|');
        if (signature === this.seated) return;
        this.seated = signature;
        const used = new Set<string>();
        GameState.pairs.slice(0, MATCH.PAIRS).forEach((pair, lane) => {
            for (const side of ['left', 'right'] as const) {
                const fighter = this.fighters.get(pair[side]);
                if (!fighter) continue;
                fighter.setLane(side, ARENA.LANES[lane]);
                fighter.standAtHome();
                fighter.setVisible(true).setAlpha(1);
                used.add(fighter.rop);
            }
        });
        for (const [slot, fighter] of this.fighters) if (!used.has(slot)) fighter.setVisible(false);
    }

    private showVerdict() {
        const order = GameState.final ? finalOrder(GameState.final.rating) : null;
        if (!order) return;
        this.seated = '';
        order.opponents.forEach((slot, i) => {
            const fighter = this.fighters.get(slot);
            if (!fighter) return;
            fighter.setLane('right', { y: 640, scale: 0.8, homeLeft: 0, homeRight: 250 + i * 195, clashX: 640 });
            fighter.setVisible(true).setAlpha(1);
            fighter.stayDown(1);
        });
        const champion = this.fighters.get(order.winner);
        if (champion) {
            champion.setLane('left', { y: 702, scale: 1.35, homeLeft: CHAMPION_X, homeRight: CHAMPION_X, clashX: 640 });
            champion.standAtHome();
            champion.setVisible(true).setAlpha(1);
            void champion.celebrate(true);
        }
        EventBus.emit(GameEvents.FINAL_END);
    }

    private nameOf = (slot: string): string => {
        const leader = GameState.leader(slot);
        return leader?.name ? surname(leader.name) : leader?.code ?? slot;
    };

    /** "Face against face" card before a fight: two big portraits slide in with the surnames and the shares. */
    private async versus(left: Fighter, right: Fighter, leftShare: number, rightShare: number): Promise<void> {
        const y = 400;
        const size = 250;
        const band = this.add.rectangle(GAME.WIDTH / 2, y, GAME.WIDTH, size + 76, 0x05060f, 0.82).setDepth(3900).setScale(1, 0);
        this.tweens.add({ targets: band, scaleY: 1, duration: 160, ease: 'Quad.easeOut' });
        const items = ([[left, leftShare, -1], [right, rightShare, 1]] as const).flatMap(([f, share, dir]) => {
            const x = GAME.WIDTH / 2 + dir * 330;
            const color = Phaser.Display.Color.HexStringToColor(f.def.color).color;
            const text = (dy: number, px: number, value: string, fill: string) => this.add.text(x, y + dy, value, {
                fontFamily: 'Impact, "Arial Black", sans-serif', fontSize: `${px}px`, color: fill, resolution: GAME.RENDER_SCALE,
            }).setOrigin(0.5).setStroke('#05060f', 10).setDepth(3920);
            const group = [
                this.add.rectangle(x, y - 14, size + 10, size + 10, color).setDepth(3905),
                this.add.image(x, y - 14, `face_${f.def.slug}`).setDisplaySize(size, size).setDepth(3910),
                text(size / 2 - 22, 50, this.nameOf(f.rop).toUpperCase(), '#ffffff'),
                text(size / 2 + 22, 32, percent(share), '#ffd23a'),
            ];
            for (const item of group) {
                const to = item.x;
                item.x = to + dir * 800;
                this.tweens.add({ targets: item, x: to, duration: 260, ease: 'Cubic.easeOut' });
            }
            return group;
        });
        const vs = this.add.text(GAME.WIDTH / 2, y, 'VS', { fontFamily: 'Impact, "Arial Black", sans-serif', fontSize: '130px', color: '#ff5a2e', resolution: GAME.RENDER_SCALE })
            .setOrigin(0.5).setStroke('#2a0500', 14).setDepth(3930).setScale(4).setAlpha(0);
        this.tweens.add({ targets: vs, scale: 1, alpha: 1, delay: 220, duration: 200, ease: 'Back.easeOut' });
        this.time.delayedCall(300, () => { this.cameras.main.shake(160, 0.008); AudioSystem.playHeavyHit(); });
        await sleep(this, 1500);
        const all = [band, vs, ...items];
        this.tweens.add({ targets: all, alpha: 0, duration: 180 });
        await sleep(this, 200);
        all.forEach(o => o.destroy());
    }

    /* ------------------------------------------------------------- queue */

    get busy(): boolean { return this.queued > 0; }

    /** `maxWaitMs`: a job that could not start for so long (the tab was hidden, the PC asleep) is dropped. */
    private enqueue(job: () => Promise<void>, maxWaitMs = Infinity) {
        this.queued++;
        const since = Date.now();
        this.queueTail = this.queueTail
            .then(() => (Date.now() - since > maxWaitMs ? undefined : job()))
            .catch(err => {
                console.error('[ArenaScene] job failed:', err);
                this.seated = '';
                for (const fighter of this.fighters.values()) fighter.engaged = false;
                this.light.focus([]);
                this.finalShown = false; // sync() shows the verdict if there is one
            })
            .then(() => {
                this.queued--;
                if (this.queued === 0) this.sync();
            });
    }

    private pairOf(slot: string): { attacker: Fighter; defender: Fighter } | null {
        const pair = GameState.pairs.find(p => p.left === slot || p.right === slot);
        if (!pair) return null;
        const attacker = this.fighters.get(slot);
        const defender = this.fighters.get(pair.left === slot ? pair.right : pair.left);
        return attacker && defender && attacker.visible && defender.visible ? { attacker, defender } : null;
    }

    /* ------------------------------------------------------------ events */

    private onStrike({ slot, amount, plan }: StrikePayload) {
        this.enqueue(async () => {
            if (this.finalShown) return;
            this.seatPairs();
            const pair = this.pairOf(slot);
            if (!pair) return;
            AudioSystem.holdTheme();
            try {
                await this.director.playStrike(pair.attacker, pair.defender, amount, plan, `+${rubles(amount)}`);
            } finally {
                AudioSystem.releaseTheme();
            }
        }, STRIKE_MAX_AGE_MS);
    }

    private onRound({ n, shares }: RoundPayload) {
        this.enqueue(async () => {
            if (this.finalShown) return;
            this.seatPairs();
            AudioSystem.holdTheme();
            try {
                emitTitle(this.scene.get('HUDScene'), GAME.WIDTH / 2, 300, `ROUND ${n}`, { size: 110, color: '#ffffff', stroke: '#16305c', holdMs: FIGHT.ROUND_INTRO_MS - 620 });
                AudioSystem.announceRound(n);
                await wallSleep(FIGHT.ROUND_INTRO_MS);
                for (const pair of GameState.pairs) { // one after another, as agreed
                    const left = this.fighters.get(pair.left);
                    const right = this.fighters.get(pair.right);
                    if (!left || !right) continue;
                    await this.versus(left, right, shares[pair.left] ?? 0, shares[pair.right] ?? 0);
                    await this.director.playRoundPair(left, right, shares[pair.left] ?? 0, shares[pair.right] ?? 0, {
                        left: this.nameOf(pair.left), right: this.nameOf(pair.right),
                    });
                }
            } finally {
                AudioSystem.releaseTheme();
            }
        }, ROUND_CATCH_UP_MS);
    }

    private onFinal({ final, demo }: FinalPayload) {
        this.enqueue(async () => {
            const order = finalOrder(final.rating);
            const champion = order ? this.fighters.get(order.winner) : undefined;
            if (!order || !champion) return;
            this.finalShown = true;
            this.seated = '';
            for (const fighter of this.fighters.values()) fighter.setVisible(false);
            AudioSystem.holdTheme();
            try {
                flashScreen(this, 0xffffff, 0.3, 200, 2);
                emitTitle(this.scene.get('HUDScene'), GAME.WIDTH / 2, 300, 'FINAL ROUND', { size: 130, color: '#ffd23a', stroke: '#5a1200', holdMs: 1800 });
                AudioSystem.voice('finalRound');
                await wallSleep(2600);
                const opponents = order.opponents.map(s => this.fighters.get(s)).filter((f): f is Fighter => !!f);
                const pct = (f: Fighter) => final.rating.find(r => r.slot === f.rop)?.pct ?? 0;
                await this.director.playFinal(champion, opponents, this.nameOf, o => this.versus(champion, o, pct(champion), pct(o)));
                emitConfettiBurst(this, 140);
                EventBus.emit(GameEvents.FINAL_END, final);
                if (!demo) DataPollingService.finalDone(final.id);
                if (demo) {
                    await sleep(this, 9000);
                    this.finalShown = false;
                    EventBus.emit(GameEvents.DATA_UPDATED);
                }
            } finally {
                for (const fighter of this.fighters.values()) fighter.engaged = false;
                this.light.focus([]);
                AudioSystem.releaseTheme();
            }
        });
    }

    private onAdminCommand(cmd: AdminCommandPayload) {
        if (cmd.type === 'celebrate') this.fighters.forEach(f => { if (f.visible && f.canSway()) void f.celebrate(); });
        if (cmd.type === 'confetti') emitConfettiBurst(this, 120);
    }
}
