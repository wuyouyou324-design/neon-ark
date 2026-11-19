import * as THREE from 'three'

const CYCLE = 4.4
const WARNING = 0.95
const ACTIVE_END = 2.55

type Laser = {
  beam: THREE.Mesh
  axis: 'x' | 'z'
  lane: number
  halfLength: number
  phase: number
}

export type MazeStatus = { hurt: boolean; active: boolean }

/** One warning/pulse/off cycle shared by visible and collidable maze beams. */
export function laserActiveAt(seconds: number, phase = 0): boolean {
  const t = ((seconds + phase) % CYCLE + CYCLE) % CYCLE
  return t >= WARNING && t < ACTIVE_END
}

/** A small neon laser grid placed over the existing first-island route. */
export class LaserMaze {
  readonly group = new THREE.Group()
  private readonly lasers: Laser[] = []
  private elapsed = 0
  private hitCooldown = 0

  constructor() {
    this.group.name = 'chapter-one-laser-maze'
    const lanes: Array<{ axis: 'x' | 'z'; lane: number; phase: number }> = [
      { axis: 'x', lane: -4.1, phase: 0 },
      { axis: 'x', lane: 1.4, phase: 1.25 },
      { axis: 'z', lane: -3.1, phase: 2.1 },
      { axis: 'z', lane: 3.8, phase: 0.7 },
    ]
    for (const entry of lanes) this.addBeam(entry.axis, entry.lane, entry.phase)
    this.addFloorGrid()
  }

  update(dt: number, player: THREE.Vector3): MazeStatus {
    this.elapsed += dt
    this.hitCooldown = Math.max(0, this.hitCooldown - dt)
    let active = false
    let collision = false
    for (const laser of this.lasers) {
      const phase = ((this.elapsed + laser.phase) % CYCLE + CYCLE) % CYCLE
      const warning = phase < WARNING
      const live = phase >= WARNING && phase < ACTIVE_END
      laser.beam.visible = phase < ACTIVE_END || phase > CYCLE - 0.45
      const material = laser.beam.material as THREE.MeshBasicMaterial
      material.color.set(live ? '#ff315d' : '#ffb44d')
      material.opacity = live ? 0.94 : warning ? 0.62 + Math.sin(this.elapsed * 16) * 0.18 : 0.24
      active ||= live
      if (!live || Math.abs(player.y - 1.15) > 1.15) continue
      const across = laser.axis === 'x' ? Math.abs(player.z - laser.lane) : Math.abs(player.x - laser.lane)
      const along = laser.axis === 'x' ? Math.abs(player.x) : Math.abs(player.z)
      if (across < 0.62 && along < laser.halfLength + 0.35) collision = true
    }
    const hurt = collision && this.hitCooldown <= 0
    if (hurt) this.hitCooldown = 1.25
    return { hurt, active }
  }

  reset(): void {
    this.elapsed = 0
    this.hitCooldown = 0
  }

  private addBeam(axis: 'x' | 'z', lane: number, phase: number): void {
    const halfLength = 5.4
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(axis === 'x' ? halfLength * 2 : 0.08, 0.11, axis === 'z' ? halfLength * 2 : 0.08),
      new THREE.MeshBasicMaterial({ color: '#ffb44d', transparent: true, opacity: 0.65, depthWrite: false }),
    )
    beam.position.set(axis === 'x' ? 0 : lane, 1.15, axis === 'x' ? lane : 0)
    beam.visible = true
    this.group.add(beam)

    const postMaterial = new THREE.MeshStandardMaterial({ color: '#273356', emissive: '#32d9e9', emissiveIntensity: 0.45, roughness: 0.52 })
    for (const sign of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 2.5, 8), postMaterial)
      post.position.set(axis === 'x' ? sign * halfLength : lane, 0.35, axis === 'x' ? lane : sign * halfLength)
      post.castShadow = true
      this.group.add(post)
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: '#7ef9ff' }))
      cap.position.set(post.position.x, 1.55, post.position.z)
      this.group.add(cap)
    }
    this.lasers.push({ beam, axis, lane, halfLength, phase })
  }

  private addFloorGrid(): void {
    const grid = new THREE.GridHelper(13, 13, '#36d8e3', '#254568')
    grid.position.y = 0.025
    const material = grid.material as THREE.Material
    material.transparent = true
    material.opacity = 0.2
    this.group.add(grid)
  }
}
