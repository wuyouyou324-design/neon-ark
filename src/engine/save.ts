/**
 * Versioned local save. Player preferences and three independent campaign slots are stored in one
 * JSON record. Parsing validates untrusted localStorage data and upgrades older version-1 saves.
 */
export type Locale = 'en' | 'zh-CN'
export type Quality = 'low' | 'medium' | 'high'
export type ScoreEntry = { name: string; score: number; seconds: number; at: number }
export type SaveSlotId = 1 | 2 | 3
export type UpgradeId = 'plasma' | 'ion' | 'deflector'
export type UpgradeLevels = Record<UpgradeId, number>

export type SlotProgress = {
  /** Highest chapter unlocked, from 1 to 3. */
  unlockedChapter: 1 | 2 | 3
  /** Last chapter launched, from 1 to 3. */
  currentChapter: 1 | 2 | 3
  credits: number
  upgrades: UpgradeLevels
  completedChapters: number[]
  totalScore: number
}

export type SaveSlot = {
  id: SaveSlotId
  progress: SlotProgress
  playedAt: number | null
}

export type SaveData = {
  version: 1
  /** '' = never chosen; the game follows the browser language until the player picks one. */
  locale: Locale | ''
  musicVolume: number
  sfxVolume: number
  muted: boolean
  sensitivity: number
  invertY: boolean
  quality: Quality
  reducedMotion: boolean
  tutorialDone: boolean
  playerName: string
  leaderboard: ScoreEntry[]
  activeSlot: SaveSlotId
  saveSlots: SaveSlot[]
}

export const SAVE_KEY = 'game3d.save'
export const LEADERBOARD_SIZE = 10
export const SLOT_COUNT = 3
export const MAX_UPGRADE_LEVEL = 5

export function defaultProgress(): SlotProgress {
  return {
    unlockedChapter: 1,
    currentChapter: 1,
    credits: 0,
    upgrades: { plasma: 0, ion: 0, deflector: 0 },
    completedChapters: [],
    totalScore: 0,
  }
}

export function defaultSlots(): SaveSlot[] {
  return [1, 2, 3].map(id => ({ id: id as SaveSlotId, progress: defaultProgress(), playedAt: null }))
}

export function defaultSave(): SaveData {
  return {
    version: 1,
    locale: '',
    musicVolume: 0.7,
    sfxVolume: 0.8,
    muted: false,
    sensitivity: 1,
    invertY: false,
    quality: 'high',
    reducedMotion: false,
    tutorialDone: false,
    playerName: 'PLAYER',
    leaderboard: [],
    activeSlot: 1,
    saveSlots: defaultSlots(),
  }
}

const clamp01 = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback)
const safeInt = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback

function parseProgress(value: unknown): SlotProgress {
  const base = defaultProgress()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base
  const p = value as Record<string, unknown>
  const levels = p.upgrades && typeof p.upgrades === 'object' ? p.upgrades as Record<string, unknown> : {}
  const completed = Array.isArray(p.completedChapters) ? p.completedChapters : []
  const completedChapters = [...new Set(completed.filter((value): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3,
  ))].sort((a, b) => a - b)
  return {
    unlockedChapter: safeInt(p.unlockedChapter, 1, 1, 3) as 1 | 2 | 3,
    currentChapter: safeInt(p.currentChapter, 1, 1, 3) as 1 | 2 | 3,
    credits: safeInt(p.credits, 0, 0, 999999),
    upgrades: {
      plasma: safeInt(levels.plasma, 0, 0, MAX_UPGRADE_LEVEL),
      ion: safeInt(levels.ion, 0, 0, MAX_UPGRADE_LEVEL),
      deflector: safeInt(levels.deflector, 0, 0, MAX_UPGRADE_LEVEL),
    },
    completedChapters,
    totalScore: safeInt(p.totalScore, 0, 0, 999999999),
  }
}

function parseSlots(value: unknown): SaveSlot[] {
  const source = Array.isArray(value) ? value : []
  const base = defaultSlots()
  return base.map(slot => {
    const raw = source.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).id === slot.id) as Record<string, unknown> | undefined
    if (!raw) return slot
    return {
      id: slot.id,
      progress: parseProgress(raw.progress),
      playedAt: typeof raw.playedAt === 'number' && Number.isFinite(raw.playedAt) ? Math.max(0, raw.playedAt) : null,
    }
  })
}

/** Parse untrusted stored JSON into a valid SaveData (pure; unit tested). */
export function parseSave(raw: string | null): SaveData {
  const base = defaultSave()
  if (!raw) return base
  let data: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base
    data = parsed as Record<string, unknown>
  } catch {
    return base
  }
  if (data.version !== 1) return base
  const board = Array.isArray(data.leaderboard) ? data.leaderboard : []
  return {
    version: 1,
    locale: data.locale === 'en' || data.locale === 'zh-CN' ? data.locale : '',
    musicVolume: clamp01(data.musicVolume, base.musicVolume),
    sfxVolume: clamp01(data.sfxVolume, base.sfxVolume),
    muted: data.muted === true,
    sensitivity: typeof data.sensitivity === 'number' && data.sensitivity >= 0.2 && data.sensitivity <= 3 ? data.sensitivity : base.sensitivity,
    invertY: data.invertY === true,
    quality: data.quality === 'low' || data.quality === 'medium' || data.quality === 'high' ? data.quality : base.quality,
    reducedMotion: data.reducedMotion === true,
    tutorialDone: data.tutorialDone === true,
    playerName: typeof data.playerName === 'string' && data.playerName.trim() ? data.playerName.trim().slice(0, 16) : base.playerName,
    leaderboard: board
      .filter((e): e is ScoreEntry => !!e && typeof e === 'object' && typeof (e as ScoreEntry).name === 'string' && Number.isFinite((e as ScoreEntry).score))
      .map(e => ({ name: e.name.slice(0, 16), score: Math.max(0, Math.floor(e.score)), seconds: Number.isFinite(e.seconds) ? e.seconds : 0, at: Number.isFinite(e.at) ? e.at : 0 }))
      .slice(0, LEADERBOARD_SIZE),
    activeSlot: data.activeSlot === 2 || data.activeSlot === 3 ? data.activeSlot : 1,
    // Missing slots are the version-1 single-save migration path; all three begin independently.
    saveSlots: parseSlots(data.saveSlots),
  }
}

/** Insert a run into a bounded, deterministically ordered leaderboard (higher score, then faster, then earlier). */
export function insertScore(board: ScoreEntry[], entry: ScoreEntry): { board: ScoreEntry[]; rank: number } {
  const next = [...board, entry].sort((a, b) => b.score - a.score || a.seconds - b.seconds || a.at - b.at).slice(0, LEADERBOARD_SIZE)
  return { board: next, rank: next.indexOf(entry) }
}

export class SaveStore {
  data: SaveData

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {
    let raw: string | null = null
    try {
      raw = this.storage?.getItem(SAVE_KEY) ?? null
    } catch {
      raw = null
    }
    this.data = parseSave(raw)
  }

  get activeSlot(): SaveSlot {
    return this.data.saveSlots.find(slot => slot.id === this.data.activeSlot) ?? this.data.saveSlots[0]
  }

  update(patch: Partial<SaveData>): void {
    this.data = { ...this.data, ...patch }
    try {
      this.storage?.setItem(SAVE_KEY, JSON.stringify(this.data))
    } catch {
      // Private browsing or quota: the game keeps working with in-memory settings.
    }
  }

  selectSlot(id: SaveSlotId): void {
    this.update({ activeSlot: id })
  }

  updateSlot(id: SaveSlotId, updater: (progress: SlotProgress) => SlotProgress): void {
    const saveSlots = this.data.saveSlots.map(slot => slot.id === id
      ? { ...slot, progress: updater(slot.progress), playedAt: Date.now() }
      : slot)
    this.update({ saveSlots })
  }

  resetSlot(id: SaveSlotId): void {
    const saveSlots = this.data.saveSlots.map(slot => slot.id === id
      ? { id, progress: defaultProgress(), playedAt: null }
      : slot)
    this.update({ saveSlots })
  }
}
