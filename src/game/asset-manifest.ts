/** Runtime assets bundled with the standalone GitHub Pages build. */
const playerCharacterUrl = new URL('../../assets/models/neon-ark-agent-animated.glb', import.meta.url).href

export const GAME_ASSETS = {
  playerCharacter: playerCharacterUrl,
} as const
