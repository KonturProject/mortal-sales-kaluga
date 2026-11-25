import { Display, Scene } from 'phaser';
import { Fighter, Hit } from '../objects/Fighter';
import { roundSeries, strikeFor, winnerOf } from './BattleRules';
import { CHAMPION_X, FINAL_LANE, FIGHT, GAME } from '../core/Constants';
import { hitStop, sleep } from '../core/Async';
import { emitBurst, emitComicText, emitTitle, flashScreen } from './Fx';
import { FxName, playFx, SPECIAL_FX } from './PixelFx';
import { ArenaLight } from './ArenaLight';
import { AudioSystem } from './Audio';

type ComboMove = 'punch' | 'kick' | 'sweep' | 'uppercut' | 'flipkick';

/** Chains the series are cut from; a series never repeats the previous chain. */
const CHAINS: ComboMove[][] = [
    ['punch', 'punch', 'kick', 'punch', 'sweep', 'kick', 'punch', 'uppercut'],
    ['flipkick', 'punch', 'punch', 'kick', 'kick', 'punch', 'sweep', 'uppercut'],
    ['punch', 'kick', 'punch', 'sweep', 'flipkick', 'punch', 'punch', 'uppercut'],
    ['kick', 'punch', 'punch', 'punch', 'flipkick', 'kick', 'sweep', 'uppercut'],
];

/** Turns the rules into choreography. Every piece is finite and awaited. */
export class FightDirector {
    private lastChain = -1;

    constructor(private scene: Scene, private light: ArenaLight) {}

    private shake(level: 0 | 1 | 2 | 3) {
        const s = FIGHT.SHAKE[level];
        this.scene.cameras.main.shake(s.ms, s.intensity);
    }

    /** Titles and counters live on the HUD layer: the arena's camera moves in and out of the fight. */
    private get hud(): Scene {
        return this.scene.scene.get('HUDScene');
    }

    private title(text: string, size: number, color: string, stroke: string, holdMs: number) {
        emitTitle(this.hud, GAME.WIDTH / 2, 290, text, { size, color, stroke, holdMs });
    }

    private chain(length: number): ComboMove[] {
        let i = Math.floor(Math.random() * CHAINS.length);
        if (i === this.lastChain) i = (i + 1) % CHAINS.length;
        this.lastChain = i;
        const chain = CHAINS[i];
        return Array.from({ length }, (_, k) => chain[k % (chain.length - 1)]);
    }

    private fx(name: FxName, at: { x: number; y: number }, attacker: Fighter, scale: number, ms: number) {
        playFx(this.scene, name, at.x, at.y, { scale, ms, flip: attacker.facing === -1, depth: 3000 });
    }

    /* ------------------------------------------------------------ pieces */

    /** One fast blow of a series. Resolves at contact plus a short beat, so blows run into each other. */
    private async quick(attacker: Fighter, defender: Fighter, move: ComboMove, hit: Hit): Promise<void> {
        await attacker.quickStrike(defender, move, at => {
            this.fx(move === 'punch' ? 'hit-spark' : 'blunt-hit', at, attacker, move === 'punch' ? 1.7 : 1.5, 300);
            emitBurst(this.scene, at.x, at.y, Display.Color.HexStringToColor(attacker.def.color).color, 6);
            AudioSystem.playHitThud();
            this.shake(0);
            hitStop(this.scene, 26);
            void defender.takeHit(hit, attacker.facing);
        });
    }

    /** The special: a short gather of power, a dash with afterimages, an explosion in the fighter's own element. */
    private async special(attacker: Fighter, defender: Fighter, hit: Hit): Promise<void> {
        const fx = SPECIAL_FX[attacker.def.slug];
        await attacker.gather();
        await attacker.quickStrike(defender, 'special', at => {
            if (fx) {
                playFx(this.scene, fx.hit, at.x, at.y, { scale: 2.6, ms: 520, flip: attacker.facing === -1, tint: fx.tint });
                playFx(this.scene, fx.ground, defender.x, defender.groundY, { scale: 2, ms: 900, tint: fx.tint, depth: defender.groundY - 1 });
            }
            this.fx('crit-hit', at, attacker, 2.1, 420);
            flashScreen(this.scene, Display.Color.HexStringToColor(attacker.def.color).color, 0.22, 110);
            AudioSystem.playHeavyHit();
            AudioSystem.playSpecial();
            this.light.pulse();
            this.shake(hit === 'launch' ? 3 : 2);
            hitStop(this.scene, 120);
            emitComicText(this.scene, at.x, at.y - 60);
            void defender.takeHit(hit, attacker.facing);
        });
    }

    /** A whole series: fast blows with a rising counter; `end` says how it closes. */
    private async series(attacker: Fighter, defender: Fighter, hits: number, end: 'push' | 'launch' | 'special'): Promise<void> {
        const moves = this.chain(hits);
        const counter = this.hud.add.text(attacker.side === 'left' ? 120 : GAME.WIDTH - 120, 250, '', {
            fontFamily: 'Impact, "Arial Black", sans-serif', fontSize: '54px', color: '#ffd23a', resolution: GAME.RENDER_SCALE,
        }).setOrigin(0.5).setStroke('#3a1200', 8).setDepth(3800);
        const bump = (n: number) => {
            counter.setText(n > 1 ? `×${n}` : '');
            this.hud.tweens.killTweensOf(counter);
            counter.setScale(1.5);
            this.hud.tweens.add({ targets: counter, scale: 1, duration: 140, ease: 'Back.easeOut' });
        };

        for (let i = 0; i < hits; i++) {
            await this.quick(attacker, defender, moves[i], moves[i] === 'sweep' ? 'low' : i % 3 === 2 ? 'push' : 'flinch');
            bump(i + 1);
            await sleep(this.scene, i < 2 ? 70 : 45);
        }
        if (end === 'launch') {
            // Uppercut, then the opponent is hit again in the air.
            await this.quick(attacker, defender, 'uppercut', 'pop');
            bump(hits + 1);
            this.fx('uppercut', { x: defender.x, y: defender.groundY }, attacker, 2, 420);
            await sleep(this.scene, 150);
            await this.quick(attacker, defender, 'flipkick', 'spike');
            bump(hits + 2);
            AudioSystem.playLaunch();
            playFx(this.scene, 'heavy-landing', defender.x, defender.groundY, { scale: 2, ms: 600 });
            await sleep(this.scene, 520);
        } else if (end === 'special') {
            await this.special(attacker, defender, 'launch');
            bump(hits + 1);
            await sleep(this.scene, 760);
            playFx(this.scene, 'ground-slam', defender.x, defender.groundY, { scale: 1.8, ms: 800, depth: defender.groundY - 1 });
        } else {
            await sleep(this.scene, 90);
        }
        this.hud.tweens.add({ targets: counter, alpha: 0, y: 220, duration: 420, onComplete: () => counter.destroy() });
        await Promise.all([defender.recover(), attacker.toStance()]);
    }

    /** Both strike at once: a clash, sparks, both slide apart. */
    private async clash(left: Fighter, right: Fighter): Promise<void> {
        await Promise.all([left.quickStrike(right, 'punch', () => {}), right.quickStrike(left, 'kick', () => {})]);
        const at = { x: (left.x + right.x) / 2, y: left.groundY - left.bodyHeight * 0.6 };
        playFx(this.scene, 'plasma-explosion', at.x, at.y, { scale: 1.7, ms: 420 });
        flashScreen(this.scene, 0xffffff, 0.25, 70);
        AudioSystem.playHeavyHit();
        this.shake(2);
        hitStop(this.scene, 110);
        await Promise.all([left.takeHit('push', -1), right.takeHit('push', 1)]);
        await Promise.all([left.recover(), right.recover()]);
    }

    /* ----------------------------------------------------------- payment */

    /** One payment = one blow; the heavier the payment, the bigger the entrance and the fall. */
    async playStrike(attacker: Fighter, defender: Fighter, amount: number, plan: number, caption: string): Promise<void> {
        const { kind, reaction } = strikeFor(amount, plan);
        attacker.engaged = defender.engaged = true;
        this.light.focus([attacker, defender], attacker.clashX, attacker.groundY);
        try {
            await Promise.all([attacker.stepIn(420), defender.stepIn(420)]);
            emitTitle(this.scene, attacker.clashX, attacker.groundY - 300, caption, { size: 44, color: '#ffd23a', stroke: '#2a1400', holdMs: 1100 });
            if (kind === 'light') {
                await this.quick(attacker, defender, Math.random() < 0.5 ? 'punch' : 'kick', 'push');
                await sleep(this.scene, 260);
            } else if (reaction === 'knockdown') {
                await this.quick(attacker, defender, 'flipkick', 'spike');
                AudioSystem.playHeavyHit();
                this.shake(2);
                await sleep(this.scene, 620);
            } else {
                await this.special(attacker, defender, 'launch');
                await sleep(this.scene, 900);
            }
            await defender.recover();
            await Promise.all([attacker.goHome(), defender.goHome()]);
        } finally {
            attacker.engaged = defender.engaged = false;
            this.light.focus([]);
        }
    }

    /* ------------------------------------------------------------- round */

    async playRoundPair(left: Fighter, right: Fighter, leftShare: number, rightShare: number, names: { left: string; right: string }): Promise<void> {
        const series = roundSeries(leftShare, rightShare);
        const verdict = winnerOf(leftShare, rightShare);
        left.engaged = right.engaged = true;
        this.light.focus([left, right], left.clashX, left.groundY);
        try {
            await Promise.all([left.stepIn(), right.stepIn()]);
            this.title('БОЙ!', 110, '#ffffff', '#7a1200', 420);
            AudioSystem.announceFight();
            await sleep(this.scene, 620);
            for (const [i, s] of series.entries()) {
                const attacker = s.side === 'left' ? left : right;
                const defender = attacker === left ? right : left;
                if (i === 1) await this.clash(left, right);
                const last = i === series.length - 1;
                if (i > 0) await attacker.somersaultIn();
                await this.series(attacker, defender, s.hits, last && verdict !== 'draw' ? 'special' : i % 2 === 1 ? 'launch' : 'push');
                if (!last) await defender.backflip();
            }
            if (verdict === 'draw') {
                this.title('НИЧЬЯ', 76, '#cfe3f5', '#1d2b44', 1000);
                await Promise.all([left.bow(), right.bow()]);
            } else {
                const winner = verdict === 'left' ? left : right;
                this.title(`${names[verdict].toUpperCase()} ПОБЕЖДАЕТ`, 62, '#ffd23a', '#3a2400', 1200);
                AudioSystem.playFanfare();
                await winner.celebrate();
                await sleep(this.scene, 800);
            }
            await Promise.all([left.goHome(), right.goHome()]);
        } finally {
            left.engaged = right.engaged = false;
            this.light.focus([]);
        }
    }

    /* ------------------------------------------------------------- final */

    async playFinal(champion: Fighter, opponents: Fighter[], nameOf: (slot: string) => string, intro: (opponent: Fighter) => Promise<void>): Promise<void> {
        champion.engaged = true;
        champion.setLane('left', FINAL_LANE);
        champion.setVisible(true).setAlpha(1).setPosition(-120, FINAL_LANE.y);
        await champion.walkTo(FINAL_LANE.homeLeft, 700);

        for (const [i, opponent] of opponents.entries()) {
            const last = i === opponents.length - 1;
            opponent.engaged = true;
            opponent.setLane('right', FINAL_LANE);
            opponent.setVisible(true).setAlpha(1).setPosition(GAME.WIDTH + 120, FINAL_LANE.y);
            this.light.focus([]);
            await sleep(this.scene, 300);
            await intro(opponent);
            this.light.focus([champion, opponent], FINAL_LANE.clashX, FINAL_LANE.y);
            await opponent.walkTo(FINAL_LANE.homeRight, 420);
            await Promise.all([champion.stepIn(320), opponent.stepIn(320)]);

            if (last) {
                await this.series(opponent, champion, 5, 'push');
                await champion.backflip();
                await this.clash(champion, opponent);
                await champion.somersaultIn();
                await this.series(champion, opponent, 9, 'launch');
                this.title('ДОБИВАЙ!', 120, '#ff4a2e', '#2a0500', 900);
                AudioSystem.announceFinish();
                await sleep(this.scene, 1400);
                playFx(this.scene, 'lightning-strike', champion.x, champion.groundY, { scale: 2.6, ms: 900 });
                await sleep(this.scene, 500);
            } else if (i % 2 === 1) {
                await this.series(opponent, champion, 2, 'push');
            }
            await champion.somersaultIn();
            const fast = 3 + Math.min(3, i);
            for (const move of this.chain(last ? 7 : fast)) {
                await this.quick(champion, opponent, move, 'flinch');
                await sleep(this.scene, 40);
            }
            if (last) {
                flashScreen(this.scene, 0xffe89a, 0.4, 200, 2);
                playFx(this.scene, 'big-explosion', opponent.x, opponent.groundY, { scale: 2.4, ms: 1500, add: false });
            }
            await this.special(champion, opponent, 'launch');
            await sleep(this.scene, 900);

            // The beaten ones stay on the floor behind the fight, spread along the back of the arena.
            opponent.setLane('right', { y: FINAL_LANE.y - 62, scale: 0.8, clashX: GAME.WIDTH / 2, homeLeft: 0, homeRight: 250 + i * (780 / Math.max(1, opponents.length - 1)) });
            opponent.stayDown(1);
            await champion.walkTo(FINAL_LANE.homeLeft + 60, 300);
        }

        this.title('НОКАУТ!', 130, '#ffd23a', '#5a1200', 1300);
        AudioSystem.voice('knockout');
        await sleep(this.scene, 1500);
        await champion.walkTo(CHAMPION_X, 900);
        this.light.focus([champion], CHAMPION_X, FINAL_LANE.y);
        playFx(this.scene, 'resurrection', champion.x, champion.groundY, { scale: 2.6, ms: 2600, depth: champion.groundY - 1 });
        AudioSystem.playFanfare();
        this.title(`ЧЕМПИОН: ${nameOf(champion.rop).toUpperCase()}`, 74, '#ffd23a', '#3a2400', 2600);
        await champion.celebrate(true);
        await sleep(this.scene, 2200);
    }
}
