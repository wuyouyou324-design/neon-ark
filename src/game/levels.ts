import type { SaveSlot, SlotProgress, UpgradeId } from '../engine/save'

export type ChapterId = 1 | 2 | 3
export type ChapterMode = 'stealth-maze' | 'orbital-shooter' | 'boss-arena'

export type ChapterData = {
  id: ChapterId
  titleKey: string
  subtitleKey: string
  mode: ChapterMode
  objectiveKey: string
  objectiveCount: number
  color: string
  reward: number
}

export const CHAPTERS: readonly ChapterData[] = [
  { id: 1, titleKey: 'chapter.one.title', subtitleKey: 'chapter.one.subtitle', mode: 'stealth-maze', objectiveKey: 'chapter.one.objective', objectiveCount: 0, color: '#43f2e4', reward: 180 },
  { id: 2, titleKey: 'chapter.two.title', subtitleKey: 'chapter.two.subtitle', mode: 'orbital-shooter', objectiveKey: 'chapter.two.objective', objectiveCount: 6, color: '#ff55d7', reward: 260 },
  { id: 3, titleKey: 'chapter.three.title', subtitleKey: 'chapter.three.subtitle', mode: 'boss-arena', objectiveKey: 'chapter.three.objective', objectiveCount: 8, color: '#ffb84d', reward: 420 },
] as const

export const CHAPTER_BY_ID = (id: ChapterId): ChapterData => CHAPTERS[id - 1]

export type UpgradeDefinition = {
  id: UpgradeId
  titleKey: string
  descriptionKey: string
  baseCost: number
  costGrowth: number
  maxLevel: number
}

export const UPGRADES: readonly UpgradeDefinition[] = [
  { id: 'plasma', titleKey: 'shop.plasma', descriptionKey: 'shop.plasma.desc', baseCost: 120, costGrowth: 90, maxLevel: 5 },
  { id: 'ion', titleKey: 'shop.ion', descriptionKey: 'shop.ion.desc', baseCost: 100, costGrowth: 75, maxLevel: 5 },
  { id: 'deflector', titleKey: 'shop.deflector', descriptionKey: 'shop.deflector.desc', baseCost: 140, costGrowth: 100, maxLevel: 5 },
] as const

export function upgradeCost(id: UpgradeId, currentLevel: number): number {
  const item = UPGRADES.find(upgrade => upgrade.id === id)!
  return item.baseCost + item.costGrowth * currentLevel
}

export function isChapterUnlocked(slot: SaveSlot, chapter: ChapterId): boolean {
  return chapter <= slot.progress.unlockedChapter
}

export function completeChapter(progress: SlotProgress, chapter: ChapterId, score: number): SlotProgress {
  const chapters = [...new Set([...progress.completedChapters, chapter])].sort((a, b) => a - b)
  const unlockedChapter = Math.max(progress.unlockedChapter, Math.min(3, chapter + 1)) as ChapterId
  const chapterReward = CHAPTER_BY_ID(chapter).reward
  return {
    ...progress,
    currentChapter: Math.min(3, chapter + 1) as ChapterId,
    unlockedChapter,
    credits: progress.credits + chapterReward + Math.max(0, Math.floor(score / 20)),
    completedChapters: chapters,
    totalScore: progress.totalScore + Math.max(0, Math.floor(score)),
  }
}

export type PurchaseResult = { ok: true; progress: SlotProgress; cost: number } | { ok: false; reason: 'insufficient' | 'maxed'; progress: SlotProgress; cost: number }

/** Pure shop transaction: validate the level and balance before charging or changing equipment. */
export function purchaseUpgrade(progress: SlotProgress, id: UpgradeId): PurchaseResult {
  const definition = UPGRADES.find(item => item.id === id)!
  const level = progress.upgrades[id]
  const cost = upgradeCost(id, level)
  if (level >= definition.maxLevel) return { ok: false, reason: 'maxed', progress, cost }
  if (progress.credits < cost) return { ok: false, reason: 'insufficient', progress, cost }
  return {
    ok: true,
    cost,
    progress: {
      ...progress,
      credits: progress.credits - cost,
      upgrades: { ...progress.upgrades, [id]: level + 1 },
    },
  }
}
