import './styles/main.css'
import { Audio } from './engine/audio'
import { I18n, resolveLocale } from './engine/i18n'
import { Input } from './engine/input'
import { GameLoop } from './engine/loop'
import { SAVE_KEY, SaveStore, type SaveData } from './engine/save'
import { completeChapter, purchaseUpgrade, type ChapterId } from './game/levels'
import { GAME_ASSETS } from './game/asset-manifest'
import type { Game } from './game/game'
import { TouchControls } from './ui/touch'
import { Ui } from './ui/ui'

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!
  const firstRun = safeGet(SAVE_KEY) === null
  const save = new SaveStore()

  const i18n = new I18n(resolveLocale(save.data.locale, navigator.languages))
  const input = new Input(canvas)
  const audio = new Audio()
  let game: Game | undefined
  let lockLostAt = 0

  const applySettings = (d: SaveData) => {
    input.sensitivity = d.sensitivity
    input.invertY = d.invertY
    audio.setVolumes(d.musicVolume, d.sfxVolume, d.muted)
    if (game) game.reducedMotion = d.reducedMotion
  }

  let activeChapter: ChapterId = save.activeSlot.progress.currentChapter
  const startRun = (tutorial: boolean, chapter: ChapterId = activeChapter) => {
    if (!game) return
    audio.unlock()
    audio.startMusic()
    activeChapter = chapter
    save.updateSlot(save.activeSlot.id, progress => ({ ...progress, currentChapter: chapter }))
    game.start(tutorial, chapter, save.activeSlot.progress.upgrades)
    ui.show('hud')
    loop.resetAccumulator()
    input.lockPointer()
  }
  const pause = () => {
    if (game?.mode !== 'playing') return
    game.pause()
    ui.show('pause')
    input.unlockPointer()
  }
  const resume = () => {
    if (game?.mode !== 'paused') return
    game.resume()
    ui.show('hud')
    loop.resetAccumulator()
    input.lockPointer()
  }

  const ui = new Ui(i18n, save, audio, input, {
    play: chapter => startRun(!save.data.tutorialDone, chapter),
    restart: () => startRun(false, activeChapter),
    resume,
    quit: () => {
      game?.toTitle()
      ui.show('title')
      input.unlockPointer()
    },
    purchase: id => {
      const slotId = save.activeSlot.id
      const result = purchaseUpgrade(save.activeSlot.progress, id)
      if (result.ok) save.updateSlot(slotId, () => result.progress)
      return result
    },
    settings: patch => {
      const qualityChanged = patch.quality !== undefined && patch.quality !== save.data.quality
      save.update(patch)
      applySettings(save.data)
      if (patch.locale) i18n.set(patch.locale)
      if (qualityChanged) game?.setQuality(save.data.quality)
    },
  })
  ui.show('boot')
  applySettings(save.data)

  // Boot: the UI above is already on screen; three.js, Rapier (WASM) and the game load as a
  // separate chunk behind the progress bar. Preload models/textures here too (engine/assets.ts).
  let loaded = 0
  const track = <T>(p: Promise<T>): Promise<T> => p.then(
    value => { ui.setBootProgress(0.1 + (++loaded / 6) * 0.9); return value },
    error => { ui.setBootProgress(0.1 + (++loaded / 6) * 0.9); throw error },
  )
  ui.setBootProgress(0.1)
  const [{ Game }, { Renderer, suggestQuality }, physics, { Assets }] = await Promise.all([
    track(import('./game/game')),
    track(import('./engine/renderer')),
    track(import('./engine/physics')),
    track(import('./engine/assets')),
    track(document.fonts.ready),
  ])
  await physics.initPhysics()
  const playerAsset = await track(new Assets().gltf(GAME_ASSETS.playerCharacter)).catch(error => {
    console.warn('Neon Ark character asset unavailable; using the built-in visual.', error)
    return undefined
  })
  ui.setBootProgress(1)
  if (firstRun) {
    save.update({ quality: suggestQuality() })
    ui.refreshSettings()
  }

  const renderer = new Renderer(canvas, save.data.quality)
  game = new Game(renderer, input, audio, {
    popup: (text, at, kind) => ui.popup(text, at, kind),
    hurt: () => ui.hurt(),
    hint: hint => ui.hint(hint),
    tutorialDone: () => save.update({ tutorialDone: true }),
    end: (run, chapter) => {
      input.unlockPointer()
      let earnedCredits = 0
      if (run.phase === 'won') {
        const slotId = save.activeSlot.id
        const previous = save.activeSlot.progress.credits
        save.updateSlot(slotId, progress => completeChapter(progress, chapter, run.score))
        earnedCredits = save.activeSlot.progress.credits - previous
      }
      window.setTimeout(() => ui.showResults(run, chapter, earnedCredits), run.phase === 'won' ? 1400 : 900)
    },
  })
  game.reducedMotion = save.data.reducedMotion
  if (playerAsset) game.installPlayerVisual(playerAsset.scene, playerAsset.animations)
  if (import.meta.env.DEV) {
    const [{ registerGameTuning }, { tuning }] = await Promise.all([
      import('../scripts/manus-tuning/adapter.js'), import('./game/tuning'),
    ])
    await registerGameTuning(tuning)
  }
  const g = game

  const loop = new GameLoop({
    beforeFrame: frameSeconds => input.update(frameSeconds),
    step: dt => g.step(dt),
    render: (alpha, frameSeconds) => {
      if (input.consume('pause') && performance.now() - lockLostAt > 300) {
        if (g.mode === 'playing') pause()
        else if (g.mode === 'paused' && ui.screen === 'pause') resume()
      }
      ui.frame(frameSeconds)
      loop.paused = g.mode === 'paused'
      g.render(alpha, frameSeconds)
      if (g.mode === 'playing' || g.mode === 'ended') ui.updateHud(g.run, g.compass(), g.chapterId, g.status, g.laserIsActive, save.activeSlot.progress.credits, g.maxLives)
    },
  })
  loop.start()

  document.addEventListener('pointerlockchange', () => {
    // Browsers release pointer lock on Escape without delivering the key: treat that as pause.
    if (!document.pointerLockElement && g.mode === 'playing' && input.method === 'keyboard') {
      lockLostAt = performance.now()
      pause()
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause()
  })
  window.addEventListener('game:pause', pause)
  canvas.addEventListener('click', () => {
    if (g.mode === 'playing') input.lockPointer()
  })
  new TouchControls(document.getElementById('ui')!, input, () => g.mode === 'playing')

  window.setTimeout(() => ui.show('title'), 250)
  // Debug/test hook (read-only use): smoke tests inspect run state through it.
  ;(window as unknown as { __game: unknown }).__game = { game: g, ui, input, save }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

boot().catch(err => {
  console.error(err)
  const el = document.getElementById('ui')
  if (el) el.innerHTML = `<div class="fatal">Failed to start: ${String((err as Error)?.message ?? err).replace(/[<>&]/g, '')}</div>`
})
