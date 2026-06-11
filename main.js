const App = require('./lib/app')
const ServerRegistration = require('./lib/servers')

const logger = require('./lib/logger')

const config = require('./config')

// gameType -> in-game material icon (Minecraft texture), mirroring MineplexUI's GameTypeMaterialKey
const gameIcons = require('./game-icons.json')

const app = new App()

function assignColor (name) {
  let hash = 0
  for (let i = name.length - 1; i >= 0; i--) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const color = Math.floor(Math.abs((Math.sin(hash) * 10000) % 1 * 16777216)).toString(16)
  return '#' + Array(6 - color.length + 1).join('0') + color
}

function fetchGameMetadata () {
  const baseUrl = process.env.MINEPLEX_API_BASE_URL || config.mineplexApi.baseUrl
  const apiKey = process.env.MINEPLEX_API_KEY || config.mineplexApi.apiKey
  const url = new URL('/v1/references/games/metadata', baseUrl)
  const http = url.protocol === 'https:' ? require('https') : require('http')

  const headers = {}
  if (apiKey) {
    headers['X-API-Key'] = apiKey
  }

  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          resolve(data.games || data)
        } catch (e) {
          reject(new Error('Failed to parse game metadata: ' + e.message))
        }
      })
    }).on('error', reject)
  })
}

async function fetchGameMetadataWithRetry () {
  const retryDelay = 15000
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchGameMetadata()
    } catch (err) {
      logger.log('warn', 'Game metadata fetch failed (attempt %d): %s - retrying in %ds', attempt, err.message, retryDelay / 1000)
      await new Promise(resolve => setTimeout(resolve, retryDelay))
    }
  }
}

async function start () {
  logger.log('info', 'Fetching game metadata from %s...', config.mineplexApi.baseUrl)

  const games = await fetchGameMetadataWithRetry()

  const playableGames = games.filter(game => game.canQueue)

  logger.log('info', 'Discovered %d game types (%d playable)', games.length, playableGames.length)

  playableGames.forEach((game, serverId) => {
    const server = {
      name: game.displayName,
      ip: 'mineplex-' + game.gameType,
      type: 'MINEPLEX_API',
      gameType: game.gameType,
      color: assignColor(game.displayName),
      favicon: gameIcons[game.gameType]
    }

    app.serverRegistrations.push(new ServerRegistration(app, serverId, server))
  })

  // "Player Servers" tile — only player-HOSTED servers (host attached), sourced from
  // /v1/game-servers/mps. The per-gameType pools (mps-legacy etc.) also contain host-less
  // standby servers, which must NOT be shown here.
  const playerServer = {
    name: 'Player Servers',
    ip: 'mineplex-player-servers',
    type: 'MINEPLEX_API',
    gameType: 'mps',
    mpsAggregate: true,
    color: assignColor('Player Servers'),
    favicon: gameIcons.mps
  }
  app.serverRegistrations.push(new ServerRegistration(app, playableGames.length, playerServer))

  if (!config.serverGraphDuration) {
    logger.log('warn', '"serverGraphDuration" is not defined in config.json - defaulting to 3 minutes!')
    config.serverGraphDuration = 3 * 60 * 10000
  }

  if (!config.logToDatabase) {
    logger.log('warn', 'Database logging is not enabled. You can enable it by setting "logToDatabase" to true in config.json. This requires sqlite3 to be installed.')
    app.handleReady()
  } else {
    app.loadDatabase(() => {
      app.handleReady()
    })
  }
}

start().catch(err => {
  logger.log('error', 'Failed to start: %s', err.message)
  process.exit(1)
})
