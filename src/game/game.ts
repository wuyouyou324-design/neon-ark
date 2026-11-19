import * as THREE from 'three'
import type { Audio } from '../engine/audio'
import type { Input } from '../engine/input'
import { Physics, RAPIER } from '../engine/physics'
import type { Renderer } from '../engine/renderer'
import type { Quality, UpgradeLevels } from '../engine/save'
import { FollowCamera } from './camera'
import { Collectibles } from './collectibles'
import { CombatEncounter, type CombatStatus } from './combat'
import { CONFIG } from './config'
import { LaserMaze } from './maze'
import { tuning } from './tuning'
import { Drones } from './drones'
import { Effects } from './fx'
import type { ChapterId } from './levels'
import { Player, type PlayerEvent } from './player'
import { collect, createRun, damage, tick, type RunState } from './rules'
import { World } from './world'

export type Mode = 'attract' | 'playing' | 'paused' | 'ended'
export type Hint = 'move' | 'look' | 'jump' | 'dash' | 'cores' | 'shoot'
export type Compass = { angle: number; distance: number; rise: number }

export type GameHooks = {
  popup(text: string, screen: { x: number; y: number }, kind: 'score' | 'hurt'): void
  hurt(): void
  hint(hint: Hint | null): void
  /** The first-run tutorial reached its last step. */
  tutorialDone(): void
  end(run: RunState, chapter: ChapterId): void
}

/**
 * One playable scene: the first mission reuses the island traversal with a timed laser grid,
 * chapter two enables a fighter/asteroid wave, and chapter three swaps in the shielded Guardian.
 * UI and persistence remain outside the simulation and communicate only through hooks.
 */
export class Game {
  mode: Mode = 'attract'
  run: RunState
  reducedMotion = false
  private readonly physics: Physics
  private readonly world: World
  private readonly player: Player
  private readonly cam: FollowCamera
  private readonly cores: Collectibles
  private readonly drones: Drones
  private readonly laserMaze: LaserMaze
  private combat: CombatEncounter
  private readonly fx = new Effects()
  private chapter: ChapterId = 1
  private upgrades: UpgradeLevels = { plasma: 0, ion: 0, deflector: 0 }
  private combatStatus: CombatStatus = { hurt: false, bossExposed: false, bossHealth: 0, attackPhase: 0 }
  private laserActive = false
  private simTime = 0
  private time = 0
  private tutorial: Hint | null = null
  private tutorialLook = 0
  private tutorialStart = new THREE.Vector3()
  private readonly down = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
  private readonly shotDirection = new THREE.Vector3()

  constructor(
    private readonly renderer: Renderer,
    private readonly input: Input,
    private readonly audio: Audio,
    private readonly hooks: GameHooks,
  ) {
    this.physics = new Physics(CONFIG.player.gravity)
    this.world = new World(this.physics, renderer.shadowMapSize)
    this.player = new Player(this.physics, this.world.spawn, this.world.movers)
    this.cam = new FollowCamera(this.physics, this.player.collider)
    this.cores = new Collectibles(this.world.coreSpots)
    this.drones = new Drones(this.physics, this.world.droneRoutes)
    this.laserMaze = new LaserMaze()
    this.combat = new CombatEncounter(1)
    this.world.scene.add(this.player.root, this.player.shadowMesh, this.cores.group, this.drones.group, this.fx.mesh, this.laserMaze.group, this.combat.group)
    this.run = createRun(this.cores.total)
    this.cam.reset(this.world.spawn, 0.6)
  }

  get camera(): THREE.PerspectiveCamera {
    return this.cam.camera
  }

  get chapterId(): ChapterId {
    return this.chapter
  }

  get status(): CombatStatus {
    return this.combatStatus
  }

  get laserIsActive(): boolean {
    return this.laserActive
  }

  get maxLives(): number {
    return CONFIG.run.lives + Math.floor(this.upgrades.deflector / 2)
  }

  /** Replace only the player's visual; physics, collision and camera stay on the logical root. */
  installPlayerVisual(scene: THREE.Group, clips: THREE.AnimationClip[]): void {
    this.player.installAnimatedVisual(scene, clips)
  }

  /** Begin (or restart) a selected chapter with the active save slot's equipment. */
  start(tutorial: boolean, chapter: ChapterId = 1, upgrades: UpgradeLevels = this.upgrades): void {
    tuning.activate('run')
    this.chapter = chapter
    this.upgrades = { ...upgrades }
    this.player.speedMultiplier = 1 + this.upgrades.ion * 0.11
    this.cores.reset()
    this.cores.group.visible = chapter === 1
    this.drones.group.visible = chapter === 1
    this.laserMaze.group.visible = chapter === 1
    this.laserMaze.reset()
    this.world.scene.remove(this.combat.group)
    this.combat.dispose()
    this.combat = new CombatEncounter(chapter)
    this.combat.setWeaponLevel(this.upgrades.plasma)
    this.world.scene.add(this.combat.group)
    this.combatStatus = { hurt: false, bossExposed: false, bossHealth: chapter === 3 ? 8 : 0, attackPhase: 0 }
    this.laserActive = false
    this.fx.clear()
    this.player.teleport(this.world.spawn)
    this.player.facing = 0
    this.cam.pitch = 0.42
    this.cam.reset(this.world.spawn, 0)
    const objectives = chapter === 1 ? this.cores.total : this.combat.objectiveCount
    const lives = this.maxLives
    this.run = { ...createRun(objectives, CONFIG, lives), unranked: tuning.unranked }
    this.mode = 'playing'
    this.input.endFrame()
    this.input.takeLook()
    this.tutorial = tutorial ? (chapter === 1 ? 'move' : 'shoot') : null
    this.tutorialLook = 0
    this.tutorialStart.copy(this.world.spawn)
    this.hooks.hint(this.tutorial)
  }

  pause(): void {
    if (this.mode === 'playing') this.mode = 'paused'
  }

  resume(): void {
    if (this.mode !== 'paused') return
    this.mode = 'playing'
    this.input.endFrame()
    this.input.takeLook()
  }

  toTitle(): void {
    this.mode = 'attract'
    this.hooks.hint(null)
  }

  setQuality(quality: Quality): void {
    this.renderer.applyQuality(quality)
    const size = this.renderer.shadowMapSize
    const shadow = this.world.sun.shadow
    shadow.map?.dispose()
    shadow.map = null
    shadow.mapSize.set(size, size)
    // Shadow support is compiled into shaders: recompile after toggling shadows at runtime.
    this.world.scene.traverse(obj => {
      const material = (obj as THREE.Mesh).material
      for (const m of Array.isArray(material) ? material : material ? [material] : []) m.needsUpdate = true
    })
  }

  step(dt: number): void {
    this.simTime += dt
    // Presses are always consumed so a jump or shot pressed in a menu never fires on resume.
    const jumpPressed = this.input.consume('jump')
    const dashPressed = this.input.consume('dash')
    const shootPressed = this.input.consume('shoot')
    const playing = this.mode === 'playing'
    const rage = playing && this.run.timeLeft <= CONFIG.drones.rageAt

    this.world.stepMovers(this.simTime)
    const events: PlayerEvent[] = []
    if (playing) {
      this.player.step(
        dt,
        {
          moveX: this.input.move.x,
          moveY: this.input.move.y,
          sprint: this.input.held('sprint'),
          jumpPressed,
          jumpHeld: this.input.held('jump'),
          dashPressed,
        },
        this.cam.yaw,
        events,
      )
    }
    if (this.chapter === 1) this.drones.step(dt, rage)
    this.physics.step(dt)
    if (!playing) return
    this.run.unranked ||= tuning.unranked

    const pos = this.player.position
    for (const e of events) this.onPlayerEvent(e, pos)

    if (this.chapter === 1) {
      for (const at of this.cores.collect(pos, CONFIG.player.radius + 0.75)) {
        const result = collect(this.run)
        this.run = result.state
        this.audio.play('pickup')
        this.fx.burst(at, '#ffd35c', 26, 7)
        const combo = this.run.combo > 1 ? `  ×${this.run.combo}` : ''
        this.hooks.popup(`+${result.points}${combo}`, this.project(at), 'score')
        if (this.tutorial === 'cores') {
          this.advanceTutorial(null)
          this.hooks.tutorialDone()
        }
      }

      const hitFrom = this.drones.hits(pos, CONFIG.player.radius)[0]
      if (hitFrom) this.damageAt(pos, hitFrom)
      const laser = this.laserMaze.update(dt, pos)
      this.laserActive = laser.active
      if (laser.hurt) this.damageAt(pos, pos.clone().add(new THREE.Vector3(0, 0, -1)))
    } else {
      this.combatStatus = this.combat.update(dt, pos)
      if (this.combatStatus.hurt) this.damageAt(pos, pos.clone().add(new THREE.Vector3(0, 0, -1)))
      if (shootPressed && this.run.phase === 'playing') this.fireWeapon()
    }

    if (pos.y < CONFIG.run.killY && this.run.phase === 'playing') {
      const result = damage(this.run, true)
      this.run = result.state
      if (result.hurt) this.onHurt(pos)
      if (this.run.phase === 'playing') {
        this.player.teleport(this.player.safe)
        this.cam.reset(this.player.safe)
      }
    }

    this.run = tick(this.run, dt)
    this.updateTutorial(pos)
    if (this.run.phase !== 'playing') {
      this.mode = 'ended'
      this.hooks.hint(null)
      this.audio.play(this.run.phase === 'won' ? 'win' : 'lose')
      if (this.run.phase === 'won') this.fx.burst(pos.clone().setY(pos.y + 1), '#7ef9ff', 60, 10)
      this.hooks.end(this.run, this.chapter)
    }
  }

  render(alpha: number, frameSeconds: number): void {
    this.time += frameSeconds
    this.physics.sync(alpha)
    const target = this.player.root.position
    if (this.mode === 'attract') {
      // Slow establishing orbit around the archipelago; the title menu sits on the left third.
      const t = this.time * 0.045 + 0.9
      const cam = this.cam.camera
      cam.position.set(Math.sin(t) * 34, 15 + Math.sin(this.time * 0.2) * 1.5, -8 + Math.cos(t) * 34)
      cam.lookAt(Math.sin(t + 1.9) * 6, 3, -8 + Math.cos(t + 1.9) * 6)
    } else {
      const look = this.mode === 'playing' ? this.input.takeLook() : { x: 0, y: 0 }
      if (this.mode === 'playing' && this.tutorial === 'look') {
        // Measure total movement, so slow input and high refresh rates can complete the hint.
        this.tutorialLook += Math.abs(look.x) + Math.abs(look.y)
        if (this.tutorialLook > 0.05) this.advanceTutorial('jump')
      }
      this.cam.update(target, look, frameSeconds, false, this.reducedMotion)
    }
    this.player.animate(frameSeconds, this.time, this.run.invulnerable > 0 && this.mode === 'playing', this.groundBelow(target))
    this.cores.animate(frameSeconds)
    this.drones.animate(frameSeconds, this.chapter === 1 && this.mode === 'playing' && this.run.timeLeft <= CONFIG.drones.rageAt)
    this.fx.update(frameSeconds)
    this.world.update(frameSeconds, target)
    this.renderer.render(this.world.scene, this.cam.camera)
  }

  /** Direction to the nearest remaining core relative to the camera (HUD compass). */
  compass(): Compass | null {
    if (this.chapter !== 1) return null
    const pos = this.player.root.position
    let best: THREE.Vector3 | undefined
    let bestD = Infinity
    for (const c of this.cores.remaining()) {
      const d = c.distanceToSquared(pos)
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    if (!best) return null
    const toCore = Math.atan2(-(best.x - pos.x), -(best.z - pos.z))
    let angle = toCore - this.cam.yaw
    angle = Math.atan2(Math.sin(angle), Math.cos(angle))
    return { angle, distance: Math.sqrt(bestD), rise: best.y - pos.y }
  }

  private fireWeapon(): void {
    this.cam.camera.getWorldDirection(this.shotDirection)
    const before = this.chapter === 2 ? this.combat.remainingTargets : this.combat.bossHealth
    const hit = this.combat.shoot(this.cam.camera.position, this.shotDirection)
    if (hit === 'shield') {
      this.fx.burst(this.player.position.clone().add(new THREE.Vector3(0, 1, -2)), '#43f2e4', 5, 2)
      return
    }
    if (!hit) return
    this.audio.play('pickup')
    const after = this.chapter === 2 ? this.combat.remainingTargets : this.combat.bossHealth
    const objectivePoints = this.chapter === 2 ? (hit === 'target' && after < before ? 1 : 0) : Math.max(0, before - after)
    for (let i = 0; i < objectivePoints && this.run.phase === 'playing'; i += 1) {
      const result = collect(this.run)
      this.run = result.state
      const combo = this.run.combo > 1 ? `  ×${this.run.combo}` : ''
      this.hooks.popup(`+${result.points}${combo}`, this.project(this.player.position.clone().add(new THREE.Vector3(0, 1, -2))), 'score')
    }
    if (this.tutorial === 'shoot') {
      this.advanceTutorial(null)
      this.hooks.tutorialDone()
    }
  }

  private damageAt(pos: THREE.Vector3, from: THREE.Vector3): void {
    const runRules = { ...CONFIG, run: { ...CONFIG.run, invulnerable: CONFIG.run.invulnerable + this.upgrades.deflector * 0.42 } }
    const result = damage(this.run, false, runRules)
    if (!result.hurt) return
    this.run = result.state
    this.player.knockback(from)
    this.onHurt(pos)
  }

  private onPlayerEvent(e: PlayerEvent, pos: THREE.Vector3): void {
    const feet = pos.clone().setY(pos.y - CONFIG.player.halfHeight - CONFIG.player.radius)
    if (e.type === 'jump') {
      this.audio.play('jump')
      this.fx.puff(feet, 0.3)
      if (this.tutorial === 'jump') this.advanceTutorial('dash')
    } else if (e.type === 'land') {
      this.audio.play('land')
      this.fx.puff(feet, e.impact)
      if (e.impact > 0.5) this.cam.addShake(e.impact * 0.5)
    } else if (e.type === 'dash') {
      this.audio.play('dash')
      this.fx.burst(pos, '#7ef9ff', 10, 3)
      if (this.tutorial === 'dash') this.advanceTutorial('cores')
    }
  }

  private onHurt(pos: THREE.Vector3): void {
    this.audio.play('hurt')
    this.cam.addShake(0.8)
    this.fx.burst(pos, '#ff4d6d', 30, 8)
    this.hooks.hurt()
    this.hooks.popup('-1', this.project(pos.clone().setY(pos.y + 1)), 'hurt')
  }

  private updateTutorial(pos: THREE.Vector3): void {
    if (this.chapter === 1 && this.tutorial === 'move' && pos.distanceTo(this.tutorialStart) > 2.5) this.advanceTutorial(this.input.method === 'touch' ? 'jump' : 'look')
  }

  private advanceTutorial(next: Hint | null): void {
    this.tutorial = next
    this.tutorialLook = 0
    this.hooks.hint(next)
  }

  private groundBelow(p: THREE.Vector3): number | null {
    this.down.origin = { x: p.x, y: p.y, z: p.z }
    const hit = this.physics.world.castRay(this.down, 30, true, undefined, undefined, this.player.collider)
    return hit ? p.y - hit.timeOfImpact : null
  }

  project(world: THREE.Vector3): { x: number; y: number } {
    const v = world.clone().project(this.cam.camera)
    const canvas = this.renderer.canvas
    return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight }
  }
}
