/** Original soundtrack and impacts, synthesized in the browser. Nothing is fetched. */

const PREF_KEY = "haelo-sound";
const BPM = 138;

type Osc = "sine" | "square" | "triangle" | "sawtooth";

export interface SoundState {
  on: boolean;
  waiting: boolean;
}

function readDesired(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

class SoundEngine {
  /** Preference: sound should play. Default on, remembered in localStorage. */
  desired = false;
  /** Audible right now (context running and bed scheduled). */
  playing = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private drive: BiquadFilterNode | null = null;
  private sfx: GainNode | null = null;
  private energy = 0;
  private energyTarget = 0;
  private lastHover = 0;
  private lastClick = 0;
  private lastWhoosh = 0;
  private lastBass = 0;
  private lastLevel = 0;
  private drones: OscillatorNode[] = [];
  private timer: number | null = null;
  private nextTime = 0;
  private stepIndex = 0;
  private listeners = new Set<(state: SoundState) => void>();
  private gestureArmed = false;
  private onGesture = (event: Event): void => {
    const target = event.target;
    if (target instanceof Element && target.closest(".sound")) return;
    if (!this.desired) {
      this.clearGesture();
      return;
    }
    void this.startAudible();
  };

  constructor() {
    if (typeof window === "undefined") return;
    this.desired = readDesired();
    if (this.desired) {
      void this.arm();
      this.watchGesture();
    }
    this.emit();
  }

  get state(): SoundState {
    return { on: this.desired, waiting: this.desired && !this.playing };
  }

  subscribe(fn: (state: SoundState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  /** Reduced motion changes visuals only. The score stays at full intensity. */
  setReduced(_reduced: boolean): void {
    /* visuals are handled in CSS and the 3D scenes */
  }

  async toggle(): Promise<boolean> {
    if (this.desired) {
      this.desired = false;
      this.playing = false;
      this.persist();
      this.clearGesture();
      this.stopBed();
      this.emit();
      return false;
    }
    this.desired = true;
    this.persist();
    await this.startAudible();
    return true;
  }

  private persist(): void {
    try {
      localStorage.setItem(PREF_KEY, this.desired ? "on" : "off");
    } catch {
      /* private mode */
    }
  }

  private emit(): void {
    const state = this.state;
    for (const fn of this.listeners) fn(state);
  }

  private watchGesture(): void {
    if (this.gestureArmed || typeof window === "undefined") return;
    this.gestureArmed = true;
    window.addEventListener("pointerdown", this.onGesture, { capture: true });
    window.addEventListener("keydown", this.onGesture, { capture: true });
    window.addEventListener("touchstart", this.onGesture, { capture: true, passive: true });
    window.addEventListener("wheel", this.onGesture, { capture: true, passive: true });
  }

  private clearGesture(): void {
    if (!this.gestureArmed || typeof window === "undefined") return;
    this.gestureArmed = false;
    window.removeEventListener("pointerdown", this.onGesture, { capture: true });
    window.removeEventListener("keydown", this.onGesture, { capture: true });
    window.removeEventListener("touchstart", this.onGesture, { capture: true });
    window.removeEventListener("wheel", this.onGesture, { capture: true });
  }

  private async arm(): Promise<void> {
    if (!this.ctx) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      const music = ctx.createGain();
      music.gain.value = 0.85;
      const drive = ctx.createBiquadFilter();
      drive.type = "lowpass";
      drive.frequency.value = 900;
      drive.Q.value = 0.7;
      music.connect(drive);
      drive.connect(master);
      this.drive = drive;
      const sfx = ctx.createGain();
      sfx.gain.value = 0.8;
      sfx.connect(master);
      this.ctx = ctx;
      this.master = master;
      this.music = music;
      this.sfx = sfx;
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  private async startAudible(): Promise<void> {
    if (!this.desired) return;
    this.clearGesture();
    await this.arm();
    this.playing = true;
    this.startBed();
    this.emit();
  }

  private startBed(): void {
    if (!this.ctx || !this.music || this.timer !== null) return;
    const ctx = this.ctx;
    const bus = this.music;
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = "sine";
    sub.frequency.value = 41.2;
    subGain.gain.value = 0.34;
    sub.connect(subGain);
    subGain.connect(bus);
    sub.start();
    const fifth = ctx.createOscillator();
    const fifthGain = ctx.createGain();
    fifth.type = "triangle";
    fifth.frequency.value = 82.4;
    fifthGain.gain.value = 0.08;
    fifth.connect(fifthGain);
    fifthGain.connect(bus);
    fifth.start();
    this.drones.push(sub, fifth);
    this.stepIndex = 0;
    this.nextTime = ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  private schedule(): void {
    if (!this.ctx || !this.music || !this.playing) return;
    if (!this.desired) return;
    this.energy += (this.energyTarget - this.energy) * 0.18;
    this.energyTarget *= 0.9;
    if (this.drive) {
      const open = 780 + this.energy * 9200;
      this.drive.frequency.setTargetAtTime(open, this.ctx.currentTime, 0.08);
      this.drive.Q.setTargetAtTime(0.6 + this.energy * 4, this.ctx.currentTime, 0.08);
    }
    const step = 60 / BPM / 4;
    const horizon = this.ctx.currentTime + 0.25;
    while (this.nextTime < horizon) {
      this.hit(this.nextTime, this.stepIndex % 64);
      this.nextTime += step;
      this.stepIndex += 1;
    }
  }

  private hit(time: number, step: number): void {
    if (!this.ctx || !this.music) return;
    const beat = step % 16;
    if (beat % 8 === 0) this.kick(time);
    if (beat === 4 || beat === 12) this.snare(time);
    if (beat % 2 === 0) this.hat(time, beat % 4 === 0 ? 0.07 : 0.035);
    const roots = [55, 55, 65.41, 73.42];
    if (beat % 4 === 0) this.toneAt(time, roots[Math.floor(step / 4) % 4] ?? 55, "sawtooth", 0.18, 0.07, this.music);
    const arp = [220, 261.63, 329.63, 392, 329.63, 261.63, 196, 246.94];
    this.toneAt(time, arp[step % arp.length] ?? 220, "square", 0.09, 0.028, this.music);
    if (step >= 48) this.riser(time, (step - 48) / 16);
    if (step === 0) this.impact(time);
  }

  private kick(time: number): void {
    if (!this.ctx || !this.music) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.12);
    gain.gain.setValueAtTime(0.7, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
    osc.connect(gain);
    gain.connect(this.music);
    osc.start(time);
    osc.stop(time + 0.24);
  }

  private snare(time: number): void {
    if (!this.ctx || !this.music) return;
    this.toneAt(time, 190, "triangle", 0.12, 0.12, this.music);
    this.noiseAt(time, 0.14, 0.18, 1800);
  }

  private hat(time: number, peak: number): void {
    this.noiseAt(time, 0.04, peak, 7000);
  }

  private riser(time: number, p: number): void {
    if (!this.ctx || !this.music) return;
    const src = this.noiseBuffer(0.12);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(300 + p * 4200, time);
    filter.Q.value = 4;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.02 + p * 0.12, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.music);
    src.start(time);
    src.stop(time + 0.12);
  }

  private impact(time: number): void {
    if (!this.ctx || !this.music) return;
    this.toneAt(time, 55, "sine", 0.45, 0.2, this.music, 32);
    this.noiseAt(time, 0.35, 0.22, 400);
  }

  private toneAt(time: number, freq: number, type: Osc, dur: number, peak: number, dest: AudioNode, slideTo?: number): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), time + dur);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(peak, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  }

  private noiseAt(time: number, dur: number, peak: number, highpass: number): void {
    if (!this.ctx || !this.music) return;
    const src = this.noiseBuffer(dur);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = highpass;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.music);
    src.start(time);
    src.stop(time + dur);
  }

  private noiseBuffer(seconds: number): AudioBufferSourceNode {
    const ctx = this.ctx as AudioContext;
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    return src;
  }

  private stopBed(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const osc of this.drones) {
      try {
        osc.stop(t + 0.03);
      } catch {
        /* already stopped */
      }
    }
    this.drones = [];
  }

  private tone(freq: number, type: Osc, dur: number, peak: number, dest: AudioNode, slideTo?: number): void {
    if (!this.ctx) return;
    this.toneAt(this.ctx.currentTime, freq, type, dur, peak, dest, slideTo);
  }

  private burst(duration: number, peak: number): void {
    if (!this.ctx || !this.sfx) return;
    const t = this.ctx.currentTime;
    const src = this.noiseBuffer(duration);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(180, t);
    filter.frequency.exponentialRampToValueAtTime(4200, t + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfx);
    src.start(t);
  }

  private sfxDest(): AudioNode | null {
    return this.playing ? this.sfx : null;
  }

  ignite(): void {
    const dest = this.sfxDest();
    if (!dest) return;
    this.burst(0.45, 0.2);
    this.tone(196, "sawtooth", 0.4, 0.04, dest, 880);
  }

  fill(): void {
    const dest = this.sfxDest();
    if (!dest) return;
    this.tone(520, "sine", 0.12, 0.06, dest, 780);
  }

  block(): void {
    const dest = this.sfxDest();
    if (!dest) return;
    this.tone(140, "sawtooth", 0.16, 0.05, dest, 70);
  }

  promote(): void {
    const dest = this.sfxDest();
    if (!dest) return;
    this.burst(0.28, 0.16);
    this.tone(220, "square", 0.22, 0.05, dest, 440);
    window.setTimeout(() => {
      if (this.sfx) this.tone(440, "triangle", 0.28, 0.06, this.sfx, 880);
    }, 90);
    window.setTimeout(() => {
      if (this.sfx) this.tone(880, "sine", 0.4, 0.05, this.sfx);
    }, 180);
  }

  demote(): void {
    const dest = this.sfxDest();
    if (!dest) return;
    this.burst(0.4, 0.22);
    this.tone(320, "sawtooth", 0.45, 0.07, dest, 48);
    this.tone(190, "square", 0.35, 0.04, dest, 60);
  }

  verify(): void {
    const dest = this.sfxDest();
    if (!dest) return;
    [660, 880, 1320].forEach((freq, i) => {
      window.setTimeout(() => {
        if (this.sfx) this.tone(freq, "sine", 0.18, 0.05, this.sfx);
      }, i * 90);
    });
  }

  panic(): void {
    this.demote();
  }

  /** 0–1 scroll speed. Opens the music filter while the page is moving. */
  setScrollEnergy(amount: number): void {
    const next = Math.max(0, Math.min(1, amount));
    if (next > this.energyTarget) this.energyTarget = next;
  }

  private gap(stamp: number, min: number): boolean {
    const now = performance.now();
    if (now - stamp < min || !this.sfxDest()) return false;
    return true;
  }

  whoosh(): void {
    if (!this.gap(this.lastWhoosh, 420)) return;
    this.lastWhoosh = performance.now();
    if (!this.ctx || !this.sfx) return;
    const t = this.ctx.currentTime;
    const src = this.noiseBuffer(0.28);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(240, t);
    filter.frequency.exponentialRampToValueAtTime(2400, t + 0.28);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfx);
    src.start(t);
    src.stop(t + 0.3);
  }

  bassHit(): void {
    if (!this.gap(this.lastBass, 380)) return;
    this.lastBass = performance.now();
    const dest = this.sfxDest();
    if (!dest || !this.ctx) return;
    this.toneAt(this.ctx.currentTime, 90, "sine", 0.28, 0.22, dest, 36);
  }

  scrollRiser(): void {
    if (!this.gap(this.lastWhoosh, 500)) return;
    this.lastWhoosh = performance.now();
    const dest = this.sfxDest();
    if (!dest || !this.ctx) return;
    this.toneAt(this.ctx.currentTime, 180, "sawtooth", 0.35, 0.05, dest, 720);
  }

  stutter(): void {
    if (!this.gap(this.lastHover, 240)) return;
    this.lastHover = performance.now();
    const dest = this.sfxDest();
    if (!dest || !this.ctx) return;
    this.toneAt(this.ctx.currentTime, 1400, "square", 0.04, 0.03, dest);
    this.toneAt(this.ctx.currentTime + 0.06, 700, "square", 0.04, 0.025, dest);
  }

  levelUp(): void {
    if (!this.gap(this.lastLevel, 1100)) return;
    this.lastLevel = performance.now();
    const dest = this.sfxDest();
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    [392, 523.25, 659.25, 784].forEach((freq, i) => this.toneAt(t + i * 0.06, freq, "triangle", 0.22, 0.06, dest));
  }

  hover(): void {
    const now = performance.now();
    if (now - this.lastHover < 110 || !this.sfxDest() || !this.ctx) return;
    this.lastHover = now;
    this.toneAt(this.ctx.currentTime, 880, "sine", 0.04, 0.02, this.sfxDest() as AudioNode);
  }

  click(): void {
    const now = performance.now();
    if (now - this.lastClick < 60) return;
    this.lastClick = now;
    const dest = this.sfxDest();
    if (!dest) return;
    this.tone(1400, "square", 0.05, 0.03, dest);
  }
}

export const sound = new SoundEngine();
