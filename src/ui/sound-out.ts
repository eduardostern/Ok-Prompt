/**
 * Plays the PSG's samples: each frame's buffer is queued right after the
 * last one on the audio clock, a little ahead of now. If the queue runs dry
 * (a slow frame, a background tab) or drifts too far ahead, it starts over
 * 50 ms ahead. A high-pass filter removes the PSG's DC offset.
 */
import { audioContext } from './audio';

export class SoundOut {
  private gain?: GainNode;
  private next = 0;
  volume = 0.7;

  constructor(readonly sampleRate: number) {}

  play(samples: Float32Array<ArrayBuffer>): void {
    const ctx = audioContext();
    if (!ctx || ctx.state !== 'running' || !samples.length) return;
    if (!this.gain) {
      this.gain = ctx.createGain();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 20;
      this.gain.connect(hp).connect(ctx.destination);
    }
    this.gain.gain.value = this.volume;
    const buf = ctx.createBuffer(1, samples.length, this.sampleRate);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const now = ctx.currentTime;
    if (this.next < now + 0.01 || this.next > now + 0.25) this.next = now + 0.05;
    src.start(this.next);
    this.next += buf.duration;
  }
}
