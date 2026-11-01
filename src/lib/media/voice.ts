/**
 * FR-08 — Voix anonymisée : vocodeur à canaux à porteuse FIXE (« voix robot »).
 *
 * Pourquoi pas un simple changement de hauteur : il est réversible (re-décaler restitue une voix
 * reconnaissable) et conserve l'intonation. Le vocodeur jette l'excitation d'origine (hauteur,
 * timbre de la source) et ne garde que l'enveloppe spectrale grossière de 18 bandes, appliquée à
 * une porteuse en dents de scie à 110 Hz (voisé) et à du bruit (sifflantes) : non réversible,
 * paroles encore compréhensibles. Limite : les mots, l'accent et le débit peuvent identifier.
 *
 * Uniquement des nœuds Web Audio natifs (pas d'AudioWorklet) : fonctionne sur iOS Safari.
 * `buildVocoder` accepte n'importe quel contexte, ce qui permet de le mesurer hors ligne.
 */

export const CARRIER_HZ = 110
const BANDS = 18
const LOW_HZ = 150
const HIGH_HZ = 6500
const NOISE_ABOVE_HZ = 3800
const Q = 7

export function logSpaced(lo: number, hi: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => lo * (hi / lo) ** (i / (n - 1)))
}

function absCurve(n: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) curve[i] = Math.abs((i / (n - 1)) * 2 - 1)
  return curve
}

function whiteNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return buffer
}

function bandpass(ctx: BaseAudioContext, frequency: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter()
  f.type = 'bandpass'
  f.frequency.value = frequency
  f.Q.value = Q
  return f
}

/** Construit le vocodeur entre `input` et `output`. Appeler `start()` pour lancer les porteuses. */
export function buildVocoder(ctx: BaseAudioContext, input: AudioNode, output: AudioNode): { start(): void; stop(): void } {
  const pre = ctx.createBiquadFilter()
  pre.type = 'highpass'
  pre.frequency.value = 80
  input.connect(pre)

  const carrier = ctx.createOscillator()
  carrier.type = 'sawtooth'
  carrier.frequency.value = CARRIER_HZ
  const noise = ctx.createBufferSource()
  noise.buffer = whiteNoise(ctx, 2)
  noise.loop = true

  const sum = ctx.createGain()
  sum.gain.value = 24
  const rectifier = absCurve(1025)
  for (const f of logSpaced(LOW_HZ, HIGH_HZ, BANDS)) {
    // Analyse : énergie de la voix dans la bande (redressement + lissage à 30 Hz)
    const rect = ctx.createWaveShaper()
    rect.curve = rectifier
    const env = ctx.createBiquadFilter()
    env.type = 'lowpass'
    env.frequency.value = 30
    pre.connect(bandpass(ctx, f)).connect(rect).connect(env)
    // Synthèse : la même bande de la porteuse, dont le gain suit l'énergie mesurée
    const vca = ctx.createGain()
    vca.gain.value = 0
    ;(f > NOISE_ABOVE_HZ ? noise : carrier).connect(bandpass(ctx, f)).connect(vca)
    env.connect(vca.gain)
    vca.connect(sum)
  }
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -18
  comp.ratio.value = 4
  sum.connect(comp).connect(output)
  return {
    start: () => {
      carrier.start()
      noise.start()
    },
    stop: () => {
      try {
        carrier.stop()
        noise.stop()
      } catch {
        /* déjà arrêté */
      }
    },
  }
}

/**
 * Piste micro → piste « voix robot » utilisable par MediaRecorder. À appeler pendant un geste de
 * l'utilisateur (iOS n'autorise un AudioContext qu'ainsi). Lève une exception si Web Audio manque :
 * l'appelant doit alors REFUSER d'enregistrer (échec fermé), jamais repasser à la voix brute.
 */
export function createRobotVoice(track: MediaStreamTrack): { track: MediaStreamTrack; close(): void } {
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) throw new Error('Web Audio indisponible')
  const ctx = new AudioCtx()
  void ctx.resume()
  const source = ctx.createMediaStreamSource(new MediaStream([track]))
  const dest = ctx.createMediaStreamDestination()
  const vocoder = buildVocoder(ctx, source, dest)
  vocoder.start()
  const out = dest.stream.getAudioTracks()[0]
  if (!out) throw new Error('piste audio de sortie absente')
  return {
    track: out,
    close: () => {
      vocoder.stop()
      void ctx.close()
    },
  }
}
