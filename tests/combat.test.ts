import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CombatEncounter } from '../src/game/combat'

describe('chapter combat encounters', () => {
  it('requires repeated hits to destroy a fighter and then removes it from the objective count', () => {
    const encounter = new CombatEncounter(2)
    encounter.group.updateMatrixWorld(true)
    const origin = new THREE.Vector3(-4, 2.8, 0)
    const direction = new THREE.Vector3(0, 0, -1)

    expect(encounter.remainingTargets).toBe(6)
    expect(encounter.shoot(origin, direction)).toBe('target')
    expect(encounter.remainingTargets).toBe(6)
    encounter.update(0.3, new THREE.Vector3(100, 100, 100))
    encounter.group.updateMatrixWorld(true)
    expect(encounter.shoot(origin, direction)).toBe('target')
    expect(encounter.remainingTargets).toBe(5)
  })

  it('damages the player on asteroid contact and suppresses repeat hits during cooldown', () => {
    const encounter = new CombatEncounter(2)
    const t = 0.25
    const firstAsteroid = new THREE.Vector3(
      -10 + Math.sin(t * 0.9) * 1.2,
      1.2 + Math.sin(t * 1.4) * 0.55,
      -34 + t * 3.2,
    )

    expect(encounter.update(t, firstAsteroid).hurt).toBe(true)
    expect(encounter.update(0.1, firstAsteroid).hurt).toBe(false)
  })

  it('cycles the Guardian through three attacks and opens a timed damage window', () => {
    const encounter = new CombatEncounter(3)
    const farPlayer = new THREE.Vector3(100, 100, 100)
    const origin = new THREE.Vector3(0, 2.1, 5)
    const direction = new THREE.Vector3(0, 0, -1)
    encounter.group.updateMatrixWorld(true)

    expect(encounter.update(0, farPlayer).attackPhase).toBe(0)
    expect(encounter.shoot(origin, direction)).toBe('shield')
    expect(encounter.update(4.1, farPlayer).attackPhase).toBe(1)
    expect(encounter.update(4, farPlayer)).toMatchObject({ attackPhase: 2, bossExposed: true })
    encounter.group.updateMatrixWorld(true)
    expect(encounter.shoot(origin, direction)).toBe('boss')
    expect(encounter.bossHealth).toBe(7)
    expect(encounter.update(3.9, farPlayer)).toMatchObject({ attackPhase: 0, bossExposed: false })
  })
})
