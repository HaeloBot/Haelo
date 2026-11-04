/** Original soundtrack and impacts, synthesized in the browser. Nothing is fetched. */

type Osc = "sine" | "square" | "triangle" | "sawtooth";

class SoundEngine {
  enabled = false;
  reduced = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private sfx: GainNode | null = null;
  private pad: OscillatorNode[] = [];
  private noise: AudioBufferSourceNode | null = null;
  private timer: number | null = null;
  private step = 0;
  private listeners = new Set<(on: boolean) => void>();

  subscribe(fn: (on: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setReduced(reduced: boolean): void {
    this.reduced = reduced;
    if (this.music) this.music.gain.value = reduced ? 0.035 : 0.08;
  }

  async toggle(): Promise<boolean> {
    if (this.enabled) {
      this.enabled = false;
      this.stopBed();
      this.emit();
      return false;
    }
    await this.arm();
    this.enabled = true;
    this.startBed();
    this.ignite();
    this.emit();
    return true;
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.enabled);
  }

  private async arm(): Promise<void> {
    if (!this.ctx) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      const music = ctx.createGain();
      music.gain.value = this.reduced ? 0.035 : 0.08;
      music.connect(master);
      const sfx = ctx.createGain();
      sfx.gain.value = this.reduced ? 0.45 : 0.85;
      sfx.connect(master);
      this.ctx = ctx;
      this.master = master;
      this.music = music;
      this.sfx = sfx;
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  private startBed(): void {
    if (!this.ctx || !this.music || this.pad.length > 0) return;
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = this.reduced ? 420 : 680;
    filter.Q.value = 0.6;
    filter.connect(this.music);
    const chord = this.reduced ? [73.42, 110, 174.61] : [73.42, 110, 146.83, 220, 261.63];
    for (const freq of chord) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = freq < 100 ? "sine" : "triangle";
      osc.frequency.value = freq;
      gain.gain.value = freq < 100 ? 0.22 : 0.05;
      osc.connect(gain);
      gain.connect(filter);
      osc.start();
      this.pad.push(osc);
    }
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.value = this.reduced ? 0.008 : 0.02;
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(this.music);
    noise.start();
    this.noise = noise;
    if (!this.reduced) {
      this.timer = window.setInterval(() => this.pulse(), 320);
    }
  }

  private stopBed(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const osc of this.pad) {
      try {
        osc.stop(t + 0.05);
      } catch {
        /* already stopped */
      }
    }
    this.pad = [];
    if (this.noise) {
      try {
        this.noise.stop(t + 0.05);
      } catch {
        /* already stopped */
      }
      this.noise = null;
    }
  }

  private pulse(): void {
    if (!this.ctx || !this.enabled || !this.music) return;
    const notes = [220, 261.63, 329.63, 392, 329.63, 293.66, 246.94, 196];
    const freq = notes[this.step % notes.length] ?? 220;
    this.tone(freq, "triangle", 0.16, 0.045, this.music);
    if (this.step % 4 === 0) this.tone(78, "sine", 0.18, 0.05, this.music, 46);
    this.step += 1;
  }

  private tone(freq: number, type: Osc, dur: number, peak: number, dest: AudioNode, slideTo?: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private burst(duration: number, peak: number): void {
    if (!this.ctx || !this.sfx) return;
    const t = this.ctx.currentTime;
    const length = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(this.reduced ? 400 : 180, t);
    filter.frequency.exponentialRampToValueAtTime(this.reduced ? 1200 : 4200, t + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfx);
    src.start(t);
  }

  private sfxDest(): AudioNode | null {
    return this.enabled ? this.sfx : null;
  }

  ignite(): void {
    const dest = this.sfxDest();
    if (!dest || !this.ctx) return;
    this.burst(this.reduced ? 0.25 : 0.55, this.reduced ? 0.08 : 0.2);
    this.tone(196, "sawtooth", 0.4, 0.04, dest, 880);
  }

  click(): void {
    const dest = this.sfxDest();
    if (!dest) return;
    this.tone(1400, "square", 0.05, 0.03, dest);
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
    this.burst(0.28, this.reduced ? 0.05 : 0.16);
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
    this.burst(this.reduced ? 0.2 : 0.45, this.reduced ? 0.06 : 0.22);
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
}

export const sound = new SoundEngine();
