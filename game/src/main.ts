import StartGame, { powerSaver } from './game/main';
import { GameState, StatusResponse } from './game/core/GameState';
import { DataPollingService } from './game/systems/DataPollingService';
import type { ArenaScene } from './game/scenes/ArenaScene';
import { AudioSystem } from './game/systems/Audio';

document.addEventListener('DOMContentLoaded', () => {
    const game = StartGame('game-container');
    AudioSystem.unlockOnGesture();
    AudioSystem.loadClips();

    // Every screen reloads itself after a new build: only between fights, away from a bell, and once per build.
    const RELOADED = 'mortal_sales_kaluga_reloaded';
    setInterval(() => {
        const arena = game.scene.getScene('ArenaScene') as ArenaScene | null;
        const now = Date.now();
        if (arena?.busy || GameState.rounds.some(r => Math.abs(now - r.at) < 5 * 60_000)) return;
        fetch('version.json', { cache: 'no-store' })
            .then(res => (res.ok ? res.json() : null))
            .then((v: { build?: string } | null) => {
                if (!v?.build || v.build === __BUILD__ || sessionStorage.getItem(RELOADED) === v.build) return;
                sessionStorage.setItem(RELOADED, v.build);
                location.reload();
            })
            .catch(() => { /* offline: next time */ });
    }, 120_000);

    if (import.meta.env.DEV) {
        // Local viewing only (`?demo=1`): buttons that play the fights without touching any data.
        if (new URLSearchParams(location.search).get('demo')) {
            const bar = document.createElement('div');
            bar.id = 'demo-bar';
            bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;display:flex;gap:6px;flex-wrap:wrap;padding:6px;background:#0b1020e6;z-index:10;font:14px Arial';
            const add = (text: string, fn: () => void) => {
                const b = document.createElement('button');
                b.textContent = text;
                b.style.cssText = 'padding:6px 10px;cursor:pointer;background:#24304e;color:#fff;border:1px solid #d8b25a;border-radius:5px';
                b.onclick = () => { if (AudioSystem.isMuted) { AudioSystem.init(); AudioSystem.toggleMute(); } fn(); };
                bar.append(b);
            };
            const play = (type: string, args: Record<string, unknown> = {}) => () => DataPollingService.routeCommand({ type, args });
            const sound = document.createElement('button');
            sound.style.cssText = 'padding:6px 10px;cursor:pointer;background:#7a1200;color:#fff;border:1px solid #d8b25a;border-radius:5px';
            const label = () => { sound.textContent = AudioSystem.isMuted ? 'Звук: выкл' : AudioSystem.waitsForClick ? 'Звук: нажмите' : 'Звук: вкл'; };
            sound.onclick = () => {
                AudioSystem.init();
                if (AudioSystem.waitsForClick) AudioSystem.resume();
                else AudioSystem.toggleMute();
                setTimeout(label, 250);
            };
            label();
            setInterval(label, 1000);
            bar.append(sound);
            for (const n of [1, 2, 3]) add(`Round ${n}`, play('round', { n }));
            add('Final Round', play('final'));
            for (const [label, share] of [['лёгкая', 0.03], ['средняя', 0.07], ['крупная', 0.14]] as const) {
                add(`Оплата: ${label}`, () => {
                    const l = GameState.leaders[Math.floor(Math.random() * GameState.leaders.length)];
                    if (l) play('hit', { rop: l.slot, amount: Math.round(l.plan * share) })();
                });
            }
            document.body.append(bar);
        }
        (window as unknown as { __debug: unknown }).__debug = {
            game, GameState, poller: DataPollingService, audio: AudioSystem,
            power: () => powerSaver?.stats(),
            injectStatus: (status: StatusResponse) => DataPollingService.applyForDebug(status),
            command: (type: string, args: Record<string, unknown> = {}) => DataPollingService.routeCommand({ type, args }),
        };
    }
});
