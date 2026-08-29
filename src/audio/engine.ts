/**
 * Fully synthesized audio (spec §9). No files, no fetches, no Howler — just Web Audio.
 *
 * Bus layout, so the sliders in Settings map onto something real:
 *
 *   music ────┐
 *   ambience ─┼─▶ master ─▶ destination
 *   sfx ──────┘
 *
 * Everything is lazy: the AudioContext is only created after a user gesture, and if the browser
 * refuses one the whole module degrades to silent no-ops rather than throwing into the game loop.
 */

export type BusName = 'music' | 'ambience' | 'sfx';
export type AmbienceId = 'room' | 'birds' | 'fire' | 'cafe' | 'none';

export interface RadioStation {
  id: string;
  name: string;
  blurb: string;
  price: number;
  /** Chord roots as semitone offsets from C, with a quality. */
  progression: Array<{ root: number; quality: 'maj9' | 'min7' | 'maj7' | 'dom7sus' | 'min9' | 'maj6' }>;
  /** Seconds per bar. */
  bar: number;
  /** Base octave for the pad. */
  octave: number;
}

export const RADIO_STATIONS: readonly RadioStation[] = [
  {
    id: 'lofi',
    name: 'Lofi Study',
    blurb: 'the one with the vinyl crackle',
    price: 0,
    bar: 3.4,
    octave: 3,
    progression: [
      { root: 0, quality: 'maj9' },
      { root: 9, quality: 'min7' },
      { root: 5, quality: 'maj7' },
      { root: 7, quality: 'dom7sus' },
    ],
  },
  {
    id: 'rainy',
    name: 'Rainy Day',
    blurb: 'slower, in a minor key, for grey afternoons',
    price: 140,
    bar: 4.4,
    octave: 3,
    progression: [
      { root: 9, quality: 'min9' },
      { root: 5, quality: 'maj7' },
      { root: 2, quality: 'min7' },
      { root: 7, quality: 'dom7sus' },
    ],
  },
  {
    id: 'sunroom',
    name: 'Sun Room',
    blurb: 'brighter, a little faster, for mornings',
    price: 180,
    bar: 2.8,
    octave: 4,
    progression: [
      { root: 5, quality: 'maj6' },
      { root: 7, quality: 'dom7sus' },
      { root: 0, quality: 'maj9' },
      { root: 4, quality: 'min7' },
    ],
  },
];

const CHORD_INTERVALS: Record<RadioStation['progression'][number]['quality'], number[]> = {
  maj9: [0, 4, 7, 11, 14],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  dom7sus: [0, 5, 7, 10],
  min9: [0, 3, 7, 10, 14],
  maj6: [0, 4, 7, 9],
};

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export interface AudioSettings {
  master: number;
  music: number;
  ambience: number;
  sfx: number;
  muted: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private buses: Record<BusName, GainNode> | null = null;
  private settings: AudioSettings = { master: 0.7, music: 0.5, ambience: 0.6, sfx: 0.8, muted: false };

  private musicTimer: number | null = null;
  private musicStep = 0;
  private station: RadioStation = RADIO_STATIONS[0];
  private musicPlaying = false;

  private ambienceNodes: AudioNode[] = [];
  private ambienceId: AmbienceId = 'none';
  private noiseBuffer: AudioBuffer | null = null;
  private purrSource: { osc: OscillatorNode; gain: GainNode } | null = null;

  private failed = false;

  get available(): boolean {
    return !this.failed;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  async resume(): Promise<boolean> {
    if (this.failed) return false;
    try {
      if (!this.ctx) this.init();
      if (!this.ctx) return false;
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx.state === 'running';
    } catch {
      this.failed = true;
      return false;
    }
  }

  private init(): void {
    try {
      const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        this.failed = true;
        return;
      }
      const ctx = new Ctor();
      this.ctx = ctx;

      const master = ctx.createGain();
      master.gain.value = this.settings.muted ? 0 : this.settings.master;
      master.connect(ctx.destination);
      this.masterGain = master;

      const make = (level: number) => {
        const g = ctx.createGain();
        g.gain.value = level;
        g.connect(master);
        return g;
      };
      this.buses = {
        music: make(this.settings.music),
        ambience: make(this.settings.ambience),
        sfx: make(this.settings.sfx),
      };

      // 2 s of brown noise, reused by rain, café murmur and the fire.
      const len = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.2;
      }
      this.noiseBuffer = buffer;
    } catch {
      this.failed = true;
      this.ctx = null;
    }
  }

  applySettings(next: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...next };
    if (!this.ctx || !this.masterGain || !this.buses) return;
    const t = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(this.settings.muted ? 0 : this.settings.master, t, 0.05);
    this.buses.music.gain.setTargetAtTime(this.settings.music, t, 0.05);
    this.buses.ambience.gain.setTargetAtTime(this.settings.ambience, t, 0.05);
    this.buses.sfx.gain.setTargetAtTime(this.settings.sfx, t, 0.05);
  }

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  /* ---------------------------------------------------------------- music */

  setStation(id: string): void {
    const found = RADIO_STATIONS.find((s) => s.id === id);
    if (found) {
      this.station = found;
      this.musicStep = 0;
    }
  }

  getStation(): RadioStation {
    return this.station;
  }

  startMusic(): void {
    if (!this.ctx || this.musicPlaying) return;
    this.musicPlaying = true;
    this.scheduleBar();
    this.startVinyl();
  }

  stopMusic(): void {
    this.musicPlaying = false;
    if (this.musicTimer !== null) {
      clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
  }

  private scheduleBar(): void {
    if (!this.ctx || !this.buses || !this.musicPlaying) return;
    this.playChord();
    this.musicStep = (this.musicStep + 1) % this.station.progression.length;
    this.musicTimer = globalThis.setTimeout(() => this.scheduleBar(), this.station.bar * 1000);
  }

  private playChord(): void {
    const ctx = this.ctx;
    const bus = this.buses?.music;
    if (!ctx || !bus) return;

    const chord = this.station.progression[this.musicStep];
    const intervals = CHORD_INTERVALS[chord.quality];
    const rootMidi = 12 * this.station.octave + chord.root;
    const now = ctx.currentTime;
    const dur = this.station.bar;

    // A soft low-pass keeps the pad behind the room instead of on top of it.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1100;
    filter.Q.value = 0.6;
    filter.connect(bus);

    for (let i = 0; i < intervals.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = midiToFreq(rootMidi + intervals[i]);
      // A few cents of detune per voice is the whole difference between "pad" and "beep".
      osc.detune.value = (i - 2) * 4;

      const gain = ctx.createGain();
      const peak = (i === 0 ? 0.16 : 0.075) / Math.sqrt(intervals.length);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.5);
      gain.gain.setValueAtTime(peak, now + dur * 0.55);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.98);

      osc.connect(gain).connect(filter);
      osc.start(now);
      osc.stop(now + dur);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }

    // A bass note an octave down, on the one.
    const bass = ctx.createOscillator();
    bass.type = 'sine';
    bass.frequency.value = midiToFreq(rootMidi - 12);
    const bassGain = ctx.createGain();
    bassGain.gain.setValueAtTime(0.0001, now);
    bassGain.gain.exponentialRampToValueAtTime(0.13, now + 0.08);
    bassGain.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.7);
    bass.connect(bassGain).connect(bus);
    bass.start(now);
    bass.stop(now + dur);
    bass.onended = () => {
      bass.disconnect();
      bassGain.disconnect();
    };
  }

  /** Vinyl crackle — sparse clicks over a very quiet noise bed. */
  private startVinyl(): void {
    const ctx = this.ctx;
    const bus = this.buses?.music;
    if (!ctx || !bus || !this.noiseBuffer) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(hp).connect(g).connect(bus);
    src.start();
    this.ambienceNodes.push(src);
  }

  /* ------------------------------------------------------------- ambience */

  setAmbience(id: AmbienceId): void {
    if (this.ambienceId === id) return;
    this.stopAmbience();
    this.ambienceId = id;
    if (!this.ctx || !this.buses || id === 'none') return;

    const ctx = this.ctx;
    const bus = this.buses.ambience;

    if (id === 'cafe' || id === 'fire' || id === 'room') {
      if (!this.noiseBuffer) return;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;

      const filter = ctx.createBiquadFilter();
      if (id === 'fire') {
        filter.type = 'lowpass';
        filter.frequency.value = 620;
      } else if (id === 'cafe') {
        filter.type = 'bandpass';
        filter.frequency.value = 480;
        filter.Q.value = 0.8;
      } else {
        filter.type = 'lowpass';
        filter.frequency.value = 320;
      }

      const gain = ctx.createGain();
      gain.gain.value = id === 'room' ? 0.1 : 0.24;

      // Slow amplitude wobble: the fire breathes, the café murmurs in bursts.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = id === 'fire' ? 1.7 : 0.35;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = id === 'fire' ? 0.09 : 0.11;
      lfo.connect(lfoGain).connect(gain.gain);
      lfo.start();

      src.connect(filter).connect(gain).connect(bus);
      src.start();
      this.ambienceNodes.push(src, lfo, gain, filter);
      return;
    }

    if (id === 'birds') {
      // Occasional two-note chirps rather than a loop.
      const tick = () => {
        if (this.ambienceId !== 'birds' || !this.ctx) return;
        this.chirp();
        this.birdTimer = globalThis.setTimeout(tick, 2500 + Math.random() * 5000);
      };
      this.birdTimer = globalThis.setTimeout(tick, 1200);
    }
  }

  private birdTimer: number | null = null;

  private chirp(): void {
    const ctx = this.ctx;
    const bus = this.buses?.ambience;
    if (!ctx || !bus) return;
    const now = ctx.currentTime;
    const base = 1800 + Math.random() * 900;
    for (let i = 0; i < 2; i++) {
      const t = now + i * 0.14;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base * (i === 0 ? 1 : 1.18), t);
      osc.frequency.exponentialRampToValueAtTime(base * 1.35, t + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      osc.connect(g).connect(bus);
      osc.start(t);
      osc.stop(t + 0.12);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
      };
    }
  }

  /** Rain is its own layer so the café can have rain *and* murmur. */
  setRain(on: boolean): void {
    if (on && !this.rainNode && this.ctx && this.buses && this.noiseBuffer) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1400;
      const g = ctx.createGain();
      g.gain.value = 0.3;
      src.connect(filter).connect(g).connect(this.buses.ambience);
      src.start();
      this.rainNode = { src, g };
    } else if (!on && this.rainNode) {
      try {
        this.rainNode.src.stop();
      } catch {
        /* already stopped */
      }
      this.rainNode.src.disconnect();
      this.rainNode.g.disconnect();
      this.rainNode = null;
    }
  }

  private rainNode: { src: AudioBufferSourceNode; g: GainNode } | null = null;

  private stopAmbience(): void {
    if (this.birdTimer !== null) {
      clearTimeout(this.birdTimer);
      this.birdTimer = null;
    }
    for (const node of this.ambienceNodes) {
      try {
        (node as AudioBufferSourceNode).stop?.();
      } catch {
        /* not a source, or already stopped */
      }
      node.disconnect();
    }
    this.ambienceNodes = [];
    this.ambienceId = 'none';
  }

  /* ------------------------------------------------------------------ sfx */

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', peak = 0.2, at = 0, glide?: number): void {
    const ctx = this.ctx;
    const bus = this.buses?.sfx;
    if (!ctx || !bus) return;
    const now = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (glide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, glide), now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g).connect(bus);
    osc.start(now);
    osc.stop(now + dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  }

  /** Soft UI blip — every button press (DESIGN.md §5). */
  blip(): void {
    this.tone(660, 0.06, 'triangle', 0.09, 0, 880);
  }

  /** End-of-session chime: a rising major triad, unhurried. */
  chime(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this.tone(f, 0.85, 'sine', 0.15, i * 0.11));
  }

  /** Gentler two-note chime for the end of a break. */
  softChime(): void {
    this.tone(392, 0.6, 'sine', 0.11, 0);
    this.tone(523.25, 0.7, 'sine', 0.1, 0.1);
  }

  /** Coin pickup. */
  coin(): void {
    this.tone(880, 0.08, 'square', 0.07);
    this.tone(1318.5, 0.14, 'square', 0.055, 0.06);
  }

  /** One nom blip per bite. */
  nom(): void {
    this.tone(220 + Math.random() * 60, 0.07, 'square', 0.06, 0, 130);
  }

  /** Purr: a low tremolo that runs while a cat is being petted. */
  startPurr(): void {
    const ctx = this.ctx;
    const bus = this.buses?.sfx;
    if (!ctx || !bus || this.purrSource) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 32;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 180;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 22;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain).connect(gain.gain);
    osc.connect(filter).connect(gain).connect(bus);
    osc.start();
    lfo.start();
    gain.gain.setTargetAtTime(0.09, ctx.currentTime, 0.08);
    this.purrSource = { osc, gain };
    this.purrExtras = [lfo, filter, lfoGain];
  }

  private purrExtras: AudioNode[] = [];

  stopPurr(): void {
    const ctx = this.ctx;
    if (!ctx || !this.purrSource) return;
    const { osc, gain } = this.purrSource;
    gain.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
    const extras = this.purrExtras;
    globalThis.setTimeout(() => {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
      osc.disconnect();
      gain.disconnect();
      for (const n of extras) {
        try {
          (n as OscillatorNode).stop?.();
        } catch {
          /* not a source */
        }
        n.disconnect();
      }
    }, 400);
    this.purrSource = null;
    this.purrExtras = [];
  }

  /** A small confirmation for buying something. */
  purchase(): void {
    this.tone(523.25, 0.1, 'triangle', 0.12);
    this.tone(783.99, 0.16, 'triangle', 0.1, 0.08);
  }

  /** Achievement fanfare — three notes, short, never a jingle. */
  fanfare(): void {
    [659.25, 830.61, 987.77].forEach((f, i) => this.tone(f, 0.4, 'triangle', 0.13, i * 0.09));
  }

  /** Camera shutter for photo mode. */
  shutter(): void {
    this.tone(2400, 0.03, 'square', 0.08);
    this.tone(900, 0.05, 'square', 0.06, 0.04);
  }

  dispose(): void {
    this.stopMusic();
    this.stopAmbience();
    this.setRain(false);
    this.stopPurr();
    try {
      void this.ctx?.close();
    } catch {
      /* nothing to close */
    }
    this.ctx = null;
    this.buses = null;
    this.masterGain = null;
  }
}

export const audio = new AudioEngine();
