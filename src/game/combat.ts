import * as THREE from 'three'
import type { ChapterId } from './levels'

type Target = { root: THREE.Group; hitPoints: number; alive: boolean; base: THREE.Vector3; phase: number }
type Asteroid = { mesh: THREE.Mesh; baseX: number; baseY: number; phase: number; speed: number }
type Projectile = { mesh: THREE.Mesh; velocity: THREE.Vector3; life: number }
export type CombatHit = 'target' | 'boss' | 'shield' | null
export type CombatStatus = { hurt: boolean; bossExposed: boolean; bossHealth: number; attackPhase: number }

const mat = (color: string, emissive = color, intensity = 1.2) => new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: intensity, roughness: 0.72, metalness: 0.18 })

/** Chapter-specific enemy waves, asteroid hazards and the Ark Guardian's shield/attack cycle. */
export class CombatEncounter {
  readonly group = new THREE.Group()
  readonly objectiveCount: number
  private readonly targets: Target[] = []
  private readonly asteroids: Asteroid[] = []
  private readonly projectiles: Projectile[] = []
  private boss?: THREE.Group
  private bossShield?: THREE.Mesh
  private attackRing?: THREE.Mesh
  private attackBeam?: THREE.Mesh
  private bossHealth_ = 8
  private elapsed = 0
  private shotCooldown = 0
  private hitCooldown = 0
  private projectileTimer = 0
  private weaponLevel = 0
  private readonly raycaster = new THREE.Raycaster()
  private readonly chapter: ChapterId

  constructor(chapter: ChapterId) {
    this.chapter = chapter
    this.objectiveCount = chapter === 2 ? 6 : chapter === 3 ? this.bossHealth_ : 0
    this.group.name = `chapter-${chapter}-encounter`
    this.group.visible = chapter !== 1
    if (chapter === 2) this.buildFighterWave()
    if (chapter === 3) this.buildBoss()
  }

  get bossHealth(): number { return this.bossHealth_ }
  get remainingTargets(): number { return this.targets.filter(target => target.alive).length }
  get bossExposed(): boolean { return this.chapter === 3 && this.elapsed % 12 >= 7.5 }

  setWeaponLevel(level: number): void {
    this.weaponLevel = THREE.MathUtils.clamp(Math.floor(level), 0, 5)
  }

  shoot(origin: THREE.Vector3, direction: THREE.Vector3): CombatHit {
    if (this.chapter === 1 || this.shotCooldown > 0) return null
    this.shotCooldown = Math.max(0.09, 0.27 - this.weaponLevel * 0.028)
    this.raycaster.set(origin, direction.clone().normalize())
    this.raycaster.far = 70
    const damage = 1 + Math.floor(this.weaponLevel / 2)
    if (this.chapter === 2) {
      const hit = this.raycaster.intersectObjects(this.targets.filter(target => target.alive).map(target => target.root), true)[0]
      if (!hit) return null
      const target = this.targets.find(candidate => candidate.alive && candidate.root.getObjectById(hit.object.id))
      if (!target) return null
      target.hitPoints -= damage
      if (target.hitPoints <= 0) {
        target.alive = false
        target.root.visible = false
      }
      return 'target'
    }
    if (!this.boss) return null
    const hit = this.raycaster.intersectObject(this.boss, true)[0]
    if (!hit) return null
    if (!this.bossExposed) return 'shield'
    this.bossHealth_ = Math.max(0, this.bossHealth_ - damage)
    if (this.bossHealth_ === 0) this.boss.visible = false
    return 'boss'
  }

  update(dt: number, player: THREE.Vector3): CombatStatus {
    this.elapsed += dt
    this.shotCooldown = Math.max(0, this.shotCooldown - dt)
    this.hitCooldown = Math.max(0, this.hitCooldown - dt)
    for (const [index, target] of this.targets.entries()) {
      if (!target.alive) continue
      target.root.position.set(
        target.base.x + Math.sin(this.elapsed * 0.8 + target.phase) * 1.2,
        target.base.y + Math.sin(this.elapsed * 1.4 + target.phase) * 0.4,
        target.base.z,
      )
      target.root.rotation.y = Math.sin(this.elapsed * 0.7 + index) * 0.25
    }
    let hurt = false
    if (this.chapter === 2) {
      for (const asteroid of this.asteroids) {
        const travel = (this.elapsed * asteroid.speed + asteroid.phase) % 42
        asteroid.mesh.position.set(asteroid.baseX + Math.sin(this.elapsed * 0.9 + asteroid.phase) * 1.2, asteroid.baseY + Math.sin(this.elapsed * 1.4 + asteroid.phase) * 0.55, -34 + travel)
        asteroid.mesh.rotation.x += dt * asteroid.speed * 0.7
        asteroid.mesh.rotation.z += dt * asteroid.speed * 0.45
        if (asteroid.mesh.position.distanceTo(player) < 1.35) hurt = true
      }
      if (hurt && this.hitCooldown <= 0) this.hitCooldown = 1.25
      else if (this.hitCooldown > 0) hurt = false
      return { hurt, bossExposed: false, bossHealth: 0, attackPhase: Math.floor(this.elapsed / 3) % 3 }
    }
    if (this.chapter === 3 && this.boss) {
      this.boss.position.y = 2.1 + Math.sin(this.elapsed * 1.2) * 0.35
      this.boss.rotation.y = Math.sin(this.elapsed * 0.3) * 0.18
      const exposed = this.bossExposed
      if (this.bossShield) {
        this.bossShield.visible = !exposed
        const shieldMat = this.bossShield.material as THREE.MeshStandardMaterial
        shieldMat.emissiveIntensity = exposed ? 0.12 : 1.5 + Math.sin(this.elapsed * 5) * 0.3
      }
      const cycle = this.elapsed % 12
      const attackPhase = Math.floor(cycle / 4)
      const attackWindow = cycle % 4 > 2.35
      const dx = player.x - this.boss.position.x
      const dz = player.z - this.boss.position.z
      const flatDistance = Math.hypot(dx, dz)
      if (this.attackBeam) {
        this.attackBeam.visible = attackWindow && attackPhase === 0
        const beamMat = this.attackBeam.material as THREE.MeshBasicMaterial
        beamMat.opacity = this.attackBeam.visible ? 0.82 + Math.sin(this.elapsed * 18) * 0.08 : 0
      }
      if (this.attackRing) {
        const pulse = attackWindow && attackPhase === 1
        this.attackRing.visible = pulse
        const radius = pulse ? 1.5 + ((cycle % 4 - 2.35) / 1.65) * 6.5 : 0.1
        this.attackRing.scale.set(radius, radius, 1)
        ;(this.attackRing.material as THREE.MeshBasicMaterial).opacity = pulse ? 0.72 : 0
      }
      if (attackWindow && attackPhase === 0 && Math.abs(dz) < 0.78 && Math.abs(dx) < 4.1) hurt = true
      if (attackWindow && attackPhase === 1) {
        const ringRadius = 1.5 + ((cycle % 4 - 2.35) / 1.65) * 6.5
        if (Math.abs(flatDistance - ringRadius) < 0.85 && player.y < 2.6) hurt = true
      }
      if (attackPhase === 2 && attackWindow) {
        this.projectileTimer -= dt
        if (this.projectileTimer <= 0) {
          this.launchProjectile(player)
          this.projectileTimer = 0.82
        }
      } else this.projectileTimer = Math.min(this.projectileTimer, 0.35)
      for (const projectile of [...this.projectiles]) {
        projectile.life -= dt
        projectile.mesh.position.addScaledVector(projectile.velocity, dt)
        if (projectile.mesh.position.distanceTo(player) < 0.8) {
          hurt = true
          this.removeProjectile(projectile)
        } else if (projectile.life <= 0) this.removeProjectile(projectile)
      }
      if (hurt && this.hitCooldown <= 0) this.hitCooldown = 1.45
      else if (this.hitCooldown > 0) hurt = false
      return { hurt, bossExposed: exposed, bossHealth: this.bossHealth_, attackPhase }
    }
    return { hurt: false, bossExposed: false, bossHealth: 0, attackPhase: 0 }
  }

  dispose(): void {
    for (const projectile of [...this.projectiles]) this.removeProjectile(projectile)
    this.group.traverse(object => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      if (Array.isArray(mesh.material)) mesh.material.forEach(material => material.dispose())
      else mesh.material?.dispose()
    })
    this.group.clear()
  }

  private buildFighterWave(): void {
    const positions = [
      new THREE.Vector3(-4, 2.8, -5), new THREE.Vector3(4, 4.2, -8),
      new THREE.Vector3(-7, 3.4, -14), new THREE.Vector3(5, 6, -18),
      new THREE.Vector3(10, 3.8, -25), new THREE.Vector3(-8, 7, -29),
    ]
    positions.forEach((position, index) => {
      const root = new THREE.Group()
      const hull = new THREE.Mesh(new THREE.OctahedronGeometry(0.78, 1), mat(index % 2 ? '#ff55d7' : '#ff694e', '#ff286c', 1.4))
      hull.scale.set(1.35, 0.62, 1.7)
      hull.castShadow = true
      root.add(hull)
      const wing = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.12, 0.52), mat('#252a46', '#7338ff', 0.8))
      wing.rotation.z = 0.08
      root.add(wing)
      const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), mat('#89ffff', '#43f2e4', 2.4))
      cockpit.position.set(0, 0.22, -0.22)
      root.add(cockpit)
      root.position.copy(position)
      this.group.add(root)
      this.targets.push({ root, hitPoints: index % 2 === 0 ? 2 : 1, alive: true, base: position.clone(), phase: index * 1.7 })
    })
    for (let i = 0; i < 8; i += 1) {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7 + (i % 3) * 0.22, 1), mat('#695a7d', '#ad74e7', 0.2))
      rock.castShadow = true
      this.group.add(rock)
      this.asteroids.push({ mesh: rock, baseX: -10 + (i % 5) * 4.8, baseY: 1.2 + (i % 4) * 1.25, phase: i * 5.1, speed: 3.2 + (i % 3) * 0.55 })
    }
  }

  private buildBoss(): void {
    const boss = new THREE.Group()
    boss.position.set(0, 2.1, -7)
    const dark = mat('#34364b', '#281e57', 0.28)
    const shell = new THREE.Mesh(new THREE.SphereGeometry(2.15, 20, 16), dark)
    shell.scale.set(1.28, 1.05, 0.74)
    shell.castShadow = true
    boss.add(shell)
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.9, 1), mat('#ff8a48', '#ff3d84', 2.3))
    core.position.set(0, 0.05, 1.42)
    boss.add(core)
    for (let i = 0; i < 3; i += 1) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.34, 2.9, 0.4), dark)
      arm.position.set((i - 1) * 1.8, -0.15, 0.22)
      arm.rotation.z = (i - 1) * -0.36
      boss.add(arm)
      const blade = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.1, 6), mat('#ff55d7', '#e032cc', 1.1))
      blade.position.set((i - 1) * 1.8, -1.88, 0.28)
      blade.rotation.x = Math.PI
      boss.add(blade)
    }
    const shield = new THREE.Mesh(new THREE.SphereGeometry(3.15, 20, 14), new THREE.MeshStandardMaterial({ color: '#73f7ff', emissive: '#20daff', emissiveIntensity: 1.7, transparent: true, opacity: 0.2, roughness: 0.35, metalness: 0.25, side: THREE.DoubleSide }))
    shield.scale.set(1.22, 1, 0.86)
    boss.add(shield)
    this.bossShield = shield

    const ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), new THREE.MeshBasicMaterial({ color: '#ff4d76', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }))
    ring.rotation.x = -Math.PI / 2
    ring.position.set(0, -1.98, 0)
    ring.visible = false
    boss.add(ring)
    this.attackRing = ring

    const beam = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.08, 0.42), new THREE.MeshBasicMaterial({ color: '#ff315d', transparent: true, opacity: 0, depthWrite: false }))
    beam.position.set(0, -1.98, 3.3)
    beam.visible = false
    boss.add(beam)
    this.attackBeam = beam

    this.boss = boss
    this.group.add(boss)
  }

  private launchProjectile(player: THREE.Vector3): void {
    if (!this.boss) return
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), new THREE.MeshBasicMaterial({ color: '#ff315d' }))
    mesh.position.copy(this.boss.position).add(new THREE.Vector3(0, 0.2, 0))
    const velocity = player.clone().add(new THREE.Vector3(0, 0.8, 0)).sub(mesh.position).normalize().multiplyScalar(8.5)
    this.group.add(mesh)
    this.projectiles.push({ mesh, velocity, life: 2.2 })
  }

  private removeProjectile(projectile: Projectile): void {
    const index = this.projectiles.indexOf(projectile)
    if (index >= 0) this.projectiles.splice(index, 1)
    this.group.remove(projectile.mesh)
    projectile.mesh.geometry.dispose()
    ;(projectile.mesh.material as THREE.Material).dispose()
  }
}
