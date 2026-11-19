import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { LaserMaze, laserActiveAt } from '../src/game/maze'

describe('energy maze laser timing', () => {
  it('has a repeatable warning/active/off window with per-lane phase offsets', () => {
    expect(laserActiveAt(0.94)).toBe(false)
    expect(laserActiveAt(0.95)).toBe(true)
    expect(laserActiveAt(2.54)).toBe(true)
    expect(laserActiveAt(2.55)).toBe(false)
    expect(laserActiveAt(4.4 + 0.95)).toBe(true)
    expect(laserActiveAt(0.2, 1.25)).toBe(true)
  })

  it('hurts on a live beam collision and enforces damage cooldown', () => {
    const maze = new LaserMaze()
    const player = new THREE.Vector3(0, 1.15, -4.1)

    expect(maze.update(1, player)).toMatchObject({ active: true, hurt: true })
    expect(maze.update(0.1, player)).toMatchObject({ active: true, hurt: false })
  })
})
