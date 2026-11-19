import * as THREE from 'three'
import { RAPIER, type Physics } from '../engine/physics'
import { CONFIG } from './config'
import { tuning } from './tuning'
import type { MovingPlatform } from './world'

export type PlayerIntent = { moveX: number; moveY: number; sprint: boolean; jumpPressed: boolean; jumpHeld: boolean; dashPressed: boolean }
export type PlayerEvent = { type: 'jump' } | { type: 'land'; impact: number } | { type: 'dash' }

const P = CONFIG.player
const UP = new THREE.Vector3(0, 1, 0)

/**
 * Third-person character on Rapier's KinematicCharacterController: the controller resolves
 * collisions, slopes, steps and ground snapping; this class owns the "game feel" (acceleration,
 * coyote time, jump buffering, variable jump height, dash, moving-platform carry).
 */
export class Player {
  readonly root = new THREE.Group()
  readonly body: RAPIER.RigidBody
  readonly collider: RAPIER.Collider
  readonly velocity = new THREE.Vector3()
  grounded = false
  facing = 0
  private readonly controller: RAPIER.KinematicCharacterController
  private readonly model = new THREE.Group()
  private eyes?: THREE.Mesh
  private readonly shadow: THREE.Mesh
  private coyote = 0
  private jumpBuffer = 0
  private jumping = false
  private dashTime = 0
  private dashCooldown = 0
  private squash = 0
  private runCycle = 0
  private mixer?: THREE.AnimationMixer
  private locomotion = new Map<string, THREE.AnimationAction>()
  private activeLocomotion?: THREE.AnimationAction
  speedMultiplier = 1
  private platform?: MovingPlatform
  /** Last position where the player stood on solid, static ground (respawn point after a fall). */
  readonly safe = new THREE.Vector3()
  private safeTimer = 0

  constructor(private readonly physics: Physics, spawn: THREE.Vector3, private readonly movers: MovingPlatform[]) {
    const world = physics.world
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z))
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(P.halfHeight, P.radius).setFriction(0), this.body)
    this.controller = world.createCharacterController(0.02)
    this.controller.enableAutostep(0.4, 0.25, false)
    this.controller.enableSnapToGround(0.35)
    this.controller.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(50))
    this.controller.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(35))
    this.controller.setApplyImpulsesToDynamicBodies(true)
    this.safe.copy(spawn)

    this.root.position.copy(spawn)
    this.eyes = this.buildModel()
    this.model.rotation.order = 'YXZ'
    this.root.add(this.model)
    physics.bind(this.body, this.root)

    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(P.radius * 1.25, 24),
      new THREE.MeshBasicMaterial({ color: '#1d1a2a', transparent: true, opacity: 0.35, depthWrite: false }),
    )
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.renderOrder = 1
  }

  get shadowMesh(): THREE.Mesh {
    return this.shadow
  }

  get position(): THREE.Vector3 {
    const t = this.body.translation()
    return new THREE.Vector3(t.x, t.y, t.z)
  }

  get dashing(): boolean {
    return this.dashTime > 0
  }

  /** Install a checked in-place rig; the Rapier body remains the sole world/camera transform. */
  installAnimatedVisual(scene: THREE.Group, clips: THREE.AnimationClip[]): void {
    this.model.traverse(object => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      if (Array.isArray(mesh.material)) mesh.material.forEach(material => material.dispose())
      else mesh.material?.dispose()
    })
    this.model.clear()
    this.eyes = undefined
    scene.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(scene)
    const size = bounds.getSize(new THREE.Vector3())
    const center = bounds.getCenter(new THREE.Vector3())
    const fitScale = size.y > 0 ? 1.9 / size.y : 1
    const pivot = new THREE.Group()
    pivot.rotation.y = Math.PI // glTF characters conventionally face +Z; gameplay travel uses local -Z.
    scene.scale.setScalar(fitScale)
    scene.position.set(-center.x * fitScale, -bounds.min.y * fitScale, -center.z * fitScale)
    pivot.add(scene)
    this.model.add(pivot)
    this.mixer = new THREE.AnimationMixer(scene)
    this.locomotion.clear()
    for (const clip of clips) {
      const source = clip.clone()
      source.tracks = source.tracks.filter(track => !/(?:^|[./])(?:root|hip|hips)(?:[.:])position$/i.test(track.name))
      // The generated run clip's measured best-matching 30 fps cycle is frames 3–22.
      // Trim a playback copy, then distribute only the residual seam correction over its first keys.
      const pinned = clip.name.toLowerCase() === 'run'
        ? trimClipWindow(source, 3 / 30, 22 / 30)
        : source
      for (const track of pinned.tracks) repairLoopSeam(track)
      pinned.resetDuration()
      const action = this.mixer.clipAction(pinned)
      action.enabled = true
      action.setLoop(THREE.LoopRepeat, Infinity)
      this.locomotion.set(clip.name.toLowerCase(), action)
    }
    this.activeLocomotion = undefined
    this.selectLocomotion('idle')
  }

  /** One fixed step. `cameraYaw` makes stick/WASD movement camera-relative. */
  step(dt: number, intent: PlayerIntent, cameraYaw: number, events: PlayerEvent[]): void {
    const forward = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw))
    const right = new THREE.Vector3().crossVectors(forward, UP)
    const wish = new THREE.Vector3().addScaledVector(right, intent.moveX).addScaledVector(forward, intent.moveY)
    const wishLen = Math.min(1, wish.length())
    if (wishLen > 0.01) wish.normalize()

    this.coyote = this.grounded ? P.coyoteTime : Math.max(0, this.coyote - dt)
    this.jumpBuffer = intent.jumpPressed ? P.jumpBuffer : Math.max(0, this.jumpBuffer - dt)
    this.dashCooldown = Math.max(0, this.dashCooldown - dt)

    // A valid jump takes priority over a dash; do not let the dash outlive its input buffer.
    const jumpReady = this.jumpBuffer > 0 && this.coyote > 0
    if (jumpReady) this.dashTime = 0

    if (intent.dashPressed && this.dashCooldown <= 0 && !jumpReady) {
      tuning.activate('dash')
      const dir = wishLen > 0.01 ? wish : new THREE.Vector3(-Math.sin(this.facing), 0, -Math.cos(this.facing))
      this.facing = Math.atan2(-dir.x, -dir.z)
      this.velocity.set(dir.x * P.dashSpeed * this.speedMultiplier, Math.max(this.velocity.y, 0), dir.z * P.dashSpeed * this.speedMultiplier)
      this.dashTime = P.dashTime
      this.dashCooldown = P.dashCooldown
      events.push({ type: 'dash' })
    }

    if (this.dashTime > 0) {
      this.dashTime -= dt
      this.velocity.y = Math.max(this.velocity.y, 0)
    } else {
      const speed = (intent.sprint ? P.sprintSpeed : P.walkSpeed) * wishLen * this.speedMultiplier
      const control = this.grounded ? 1 : P.airControl
      const target = wish.clone().multiplyScalar(speed)
      const horizontal = new THREE.Vector3(this.velocity.x, 0, this.velocity.z)
      horizontal.lerp(target, 1 - Math.exp(-(P.acceleration / 6) * control * dt))
      this.velocity.x = horizontal.x
      this.velocity.z = horizontal.z

      if (jumpReady) {
        tuning.activate('jump')
        this.velocity.y = P.jumpSpeed
        this.jumping = true
        this.jumpBuffer = 0
        this.coyote = 0
        this.grounded = false
        this.platform = undefined
        this.squash = -0.35
        events.push({ type: 'jump' })
      }
      const rising = this.velocity.y > 0
      const gravity = rising && this.jumping && !intent.jumpHeld ? P.lowJumpGravity : P.gravity
      this.velocity.y = Math.max(P.maxFall, this.velocity.y + gravity * dt)
    }

    if (wishLen > 0.1 && this.dashTime <= 0) {
      const targetYaw = Math.atan2(-wish.x, -wish.z)
      this.facing = dampAngle(this.facing, targetYaw, P.turnSpeed, dt)
    }

    const desired = this.velocity.clone().multiplyScalar(dt)
    if (this.platform) desired.add(this.platform.delta)
    this.controller.computeColliderMovement(this.collider, desired)
    const moved = this.controller.computedMovement()
    const wasGrounded = this.grounded
    this.grounded = this.controller.computedGrounded()

    // Bumped a ceiling: stop rising. Hit a wall mid-dash: end the dash.
    if (this.velocity.y > 0 && moved.y < desired.y - 1e-3) this.velocity.y = 0
    if (this.grounded) {
      if (!wasGrounded && this.velocity.y < -6) {
        events.push({ type: 'land', impact: Math.min(1, -this.velocity.y / 30) })
        this.squash = Math.min(0.45, -this.velocity.y / 60)
      }
      if (this.velocity.y < 0) this.velocity.y = -1
      this.jumping = false
    }

    const cur = this.body.translation()
    const next = { x: cur.x + moved.x, y: cur.y + moved.y, z: cur.z + moved.z }
    this.body.setNextKinematicTranslation(next)
    this.platform = this.grounded ? this.findPlatform(next) : undefined

    if (this.grounded && !this.platform) {
      this.safeTimer += dt
      if (this.safeTimer > 0.4) this.safe.set(next.x, next.y + 0.2, next.z)
    } else {
      this.safeTimer = 0
    }
  }

  private findPlatform(pos: { x: number; y: number; z: number }): MovingPlatform | undefined {
    const feet = pos.y - P.halfHeight - P.radius
    return this.movers.find(m => {
      const c = m.body.translation()
      const top = c.y + m.half.y
      return Math.abs(feet - top) < 0.2 && Math.abs(pos.x - c.x) < m.half.x + P.radius * 0.6 && Math.abs(pos.z - c.z) < m.half.z + P.radius * 0.6
    })
  }

  /** Teleport (respawn). Clears velocity and interpolation so the camera does not streak. */
  teleport(to: THREE.Vector3): void {
    this.body.setTranslation(to, true)
    this.body.setNextKinematicTranslation(to)
    this.velocity.set(0, 0, 0)
    this.platform = undefined
    this.dashTime = 0
    this.root.position.copy(to)
    this.physics.snap(this.body)
  }

  /** Knock the player away from a hazard. */
  knockback(from: THREE.Vector3): void {
    const away = this.position.sub(from).setY(0)
    if (away.lengthSq() < 1e-4) away.set(1, 0, 0)
    away.normalize().multiplyScalar(9)
    this.velocity.set(away.x, 7, away.z)
    this.dashTime = 0
    this.grounded = false
    this.platform = undefined
  }

  /** Visual-only animation, once per rendered frame after `physics.sync()`. */
  animate(frameSeconds: number, time: number, invulnerable: boolean, ground: number | null): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z)
    this.model.rotation.y = this.facing
    this.mixer?.update(frameSeconds)
    this.squash = THREE.MathUtils.damp(this.squash, 0, 10, frameSeconds)
    const stretch = this.grounded ? 0 : THREE.MathUtils.clamp(this.velocity.y / 60, -0.12, 0.18)
    const s = 1 - this.squash + stretch
    this.model.scale.set(1 / Math.sqrt(Math.max(s, 0.5)), s, 1 / Math.sqrt(Math.max(s, 0.5)))
    if (this.grounded && speed > 0.5) this.runCycle += frameSeconds * speed * 1.6
    const clipName = speed < 0.55 ? 'idle' : speed > P.walkSpeed * this.speedMultiplier * 0.88 ? 'run' : 'walk'
    this.selectLocomotion(clipName)
    const bob = this.grounded ? Math.abs(Math.sin(this.runCycle)) * 0.08 * Math.min(1, speed / 6) : 0
    this.model.position.y = bob
    this.model.rotation.x = -Math.min(0.28, speed / 40) * (this.dashing ? 1.6 : 1)
    this.model.visible = !invulnerable || Math.floor(time * 16) % 2 === 0
    if (this.eyes) (this.eyes.material as THREE.MeshStandardMaterial).emissiveIntensity = this.dashing ? 4 : 2.2

    // Blob shadow: always-on depth cue for platforming, even with real shadows disabled.
    if (ground === null) {
      this.shadow.visible = false
    } else {
      const feet = this.root.position.y - P.halfHeight - P.radius
      const height = Math.max(0, feet - ground)
      this.shadow.visible = height < 14
      this.shadow.position.set(this.root.position.x, ground + 0.03, this.root.position.z)
      const k = THREE.MathUtils.clamp(1 - height / 14, 0.25, 1)
      this.shadow.scale.setScalar(k)
      ;(this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.38 * k
    }
  }

  private buildModel(): THREE.Mesh {
    const shell = new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.45, metalness: 0.05 })
    const accent = new THREE.MeshStandardMaterial({ color: '#ff7a45', roughness: 0.5 })
    const dark = new THREE.MeshStandardMaterial({ color: '#23213a', roughness: 0.3, metalness: 0.2 })
    const eyes = new THREE.MeshStandardMaterial({ color: '#7ef9ff', emissive: '#7ef9ff', emissiveIntensity: 2.2 })

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.36, 6, 16), shell)
    torso.position.y = -0.3
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.06, 8, 24), accent)
    belt.rotation.x = Math.PI / 2
    belt.position.y = -0.36
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), shell)
    head.position.y = 0.42
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 12, Math.PI * 0.6, Math.PI * 0.8, Math.PI * 0.3, Math.PI * 0.38), dark)
    visor.position.set(0, 0.42, -0.07)
    visor.rotation.y = Math.PI
    const eyeGeo = new THREE.CapsuleGeometry(0.045, 0.08, 4, 8)
    const eyeL = new THREE.Mesh(eyeGeo, eyes)
    const eyeR = new THREE.Mesh(eyeGeo, eyes)
    eyeL.position.set(-0.12, 0.44, -0.36)
    eyeR.position.set(0.12, 0.44, -0.36)
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.28, 6), dark)
    antenna.position.set(0.14, 0.9, 0.04)
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshStandardMaterial({ color: '#ff7a45', emissive: '#ff7a45', emissiveIntensity: 1.2 }))
    tip.position.set(0.14, 1.06, 0.04)
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.44, 0.2), accent)
    pack.position.set(0, -0.2, 0.36)
    const footGeo = new THREE.SphereGeometry(0.16, 12, 8)
    const footL = new THREE.Mesh(footGeo, dark)
    const footR = new THREE.Mesh(footGeo, dark)
    footL.scale.set(1, 0.6, 1.3)
    footR.scale.set(1, 0.6, 1.3)
    footL.position.set(-0.17, -0.84, -0.04)
    footR.position.set(0.17, -0.84, -0.04)

    for (const m of [torso, belt, head, visor, antenna, tip, pack, footL, footR, eyeL, eyeR]) {
      m.castShadow = true
      this.model.add(m)
    }
    return eyeL
  }

  private selectLocomotion(name: string): void {
    const next = this.locomotion.get(name) ?? this.locomotion.get('idle') ?? this.locomotion.values().next().value
    if (!next || next === this.activeLocomotion) return
    next.reset().fadeIn(0.18).play()
    this.activeLocomotion?.fadeOut(0.18)
    this.activeLocomotion = next
  }
}

function trimClipWindow(source: THREE.AnimationClip, start: number, end: number): THREE.AnimationClip {
  const tracks = source.tracks.map(track => {
    const valueSize = track.getValueSize()
    const times = [start, ...[...track.times].filter(time => time > start + 1e-5 && time < end - 1e-5), end]
    const evaluatable = track as THREE.KeyframeTrack & { createInterpolant(): { evaluate(time: number): ArrayLike<number> } }
    const interpolant = evaluatable.createInterpolant()
    const values: number[] = []
    for (const time of times) {
      const value = interpolant.evaluate(time)
      for (let i = 0; i < valueSize; i += 1) values.push(value[i])
    }
    const trimmed = track.clone()
    trimmed.times = new Float32Array(times.map(time => time - start))
    trimmed.values = new Float32Array(values)
    return trimmed
  })
  return new THREE.AnimationClip(source.name, end - start, tracks, source.blendMode)
}

function repairLoopSeam(track: THREE.KeyframeTrack): void {
  const size = track.getValueSize()
  const count = track.times.length
  if (count < 2) return
  const values = track.values
  const read = (key: number) => Array.from(values.slice(key * size, (key + 1) * size))
  const distance = (a: number[], b: number[]) => {
    if (track.ValueTypeName === 'quaternion' && size === 4) {
      const qa = new THREE.Quaternion().fromArray(a).normalize()
      const qb = new THREE.Quaternion().fromArray(b).normalize()
      return 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(qa.dot(qb)), -1, 1))
    }
    return Math.sqrt(a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0))
  }
  const first = read(0)
  const last = read(count - 1)
  const wrap = distance(last, first)
  const edge = Math.max(distance(first, read(1)), distance(read(count - 2), last))
  if (wrap <= edge + 1e-6) return

  const blendSpan = Math.min(4, count - 1)
  for (let key = 0; key < blendSpan; key += 1) {
    const offset = key * size
    const alpha = 1 - key / blendSpan
    const from = read(key)
    if (track.ValueTypeName === 'quaternion' && size === 4) {
      const q = new THREE.Quaternion().fromArray(from).normalize()
      const target = new THREE.Quaternion().fromArray(last).normalize()
      q.slerp(target, alpha)
      const corrected = q.toArray()
      for (let i = 0; i < size; i += 1) values[offset + i] = corrected[i]
    } else {
      for (let i = 0; i < size; i += 1) values[offset + i] = from[i] + (last[i] - from[i]) * alpha
    }
  }
}

function dampAngle(from: number, to: number, lambda: number, dt: number): number {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return from + delta * (1 - Math.exp(-lambda * dt))
}
