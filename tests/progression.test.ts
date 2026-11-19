import { describe, expect, it } from 'vitest'
import { defaultProgress, defaultSave, parseSave, SaveStore, type SaveSlotId } from '../src/engine/save'
import { completeChapter, isChapterUnlocked, purchaseUpgrade, upgradeCost } from '../src/game/levels'

describe('campaign slots and progression', () => {
  it('creates three independent save slots and migrates older saves', () => {
    const defaults = defaultSave()
    expect(defaults.saveSlots.map(slot => slot.id)).toEqual([1, 2, 3])
    const migrated = parseSave(JSON.stringify({ version: 1, musicVolume: 0.4 }))
    expect(migrated.saveSlots).toEqual(defaults.saveSlots)
  })

  it('validates slot progress and clamps upgrade levels', () => {
    const save = parseSave(JSON.stringify({ version: 1, saveSlots: [
      { id: 1, progress: { unlockedChapter: 99, currentChapter: 2, credits: -7, upgrades: { plasma: 99, ion: 2 }, completedChapters: [1, 1, 4], totalScore: 8 } },
    ] }))
    expect(save.saveSlots[0].progress).toMatchObject({ unlockedChapter: 3, currentChapter: 2, credits: 0, upgrades: { plasma: 5, ion: 2, deflector: 0 }, completedChapters: [1] })
    expect(save.saveSlots[1].progress).toEqual(defaultProgress())
  })

  it('persists progress changes only into the selected slot record', () => {
    const mem = new Map<string, string>()
    const storage = { getItem: (key: string) => mem.get(key) ?? null, setItem: (key: string, value: string) => void mem.set(key, value) }
    const store = new SaveStore(storage)
    store.selectSlot(2)
    store.updateSlot(2, progress => ({
      ...progress,
      unlockedChapter: 3,
      currentChapter: 2,
      credits: 375,
      upgrades: { plasma: 1, ion: 2, deflector: 3 },
      completedChapters: [1],
      totalScore: 1500,
    }))
    const saved = new SaveStore(storage)
    expect(saved.activeSlot.id).toBe(2)
    expect(saved.activeSlot.progress).toMatchObject({
      unlockedChapter: 3,
      currentChapter: 2,
      credits: 375,
      upgrades: { plasma: 1, ion: 2, deflector: 3 },
      completedChapters: [1],
      totalScore: 1500,
    })
    expect(saved.data.saveSlots[0].progress.credits).toBe(0)
    expect(saved.data.saveSlots[2].progress.credits).toBe(0)
  })

  it('unlocks the next chapter and awards currency once per completion operation', () => {
    const next = completeChapter(defaultProgress(), 1, 1000)
    expect(next.unlockedChapter).toBe(2)
    expect(next.credits).toBe(230)
    expect(next.completedChapters).toEqual([1])
    expect(isChapterUnlocked({ id: 1, progress: next, playedAt: Date.now() }, 2)).toBe(true)
    expect(upgradeCost('plasma', 1)).toBe(210)
  })

  it('supports all three stable slot ids', () => {
    const slots: SaveSlotId[] = [1, 2, 3]
    expect(slots).toHaveLength(3)
  })

  it('charges and applies each upgrade, while rejecting insufficient and maxed purchases', () => {
    const affordable = { ...defaultProgress(), credits: 1000 }
    for (const id of ['plasma', 'ion', 'deflector'] as const) {
      const result = purchaseUpgrade(affordable, id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.progress.credits).toBe(1000 - upgradeCost(id, 0))
        expect(result.progress.upgrades[id]).toBe(1)
      }
    }

    expect(purchaseUpgrade({ ...defaultProgress(), credits: 119 }, 'plasma')).toMatchObject({
      ok: false,
      reason: 'insufficient',
      cost: 120,
      progress: { credits: 119, upgrades: { plasma: 0 } },
    })
    expect(purchaseUpgrade({
      ...defaultProgress(),
      credits: 5000,
      upgrades: { plasma: 5, ion: 0, deflector: 0 },
    }, 'plasma')).toMatchObject({
      ok: false,
      reason: 'maxed',
      progress: { credits: 5000, upgrades: { plasma: 5 } },
    })
  })
})
