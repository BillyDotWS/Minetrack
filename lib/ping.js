const logger = require('./logger')
const MessageOf = require('./message')
const { TimeTracker } = require('./time')

const { getPlayerCountOrNull } = require('./util')

const config = require('../config')

// Cached player counts from the API — shared across all servers per ping cycle
let _apiCachePromise = null
let _apiCacheTime = 0

function fetchPlayerCounts (timeout) {
  const baseUrl = process.env.MINEPLEX_API_BASE_URL || config.mineplexApi.baseUrl
  const apiKey = process.env.MINEPLEX_API_KEY || config.mineplexApi.apiKey
  const url = new URL('/v1/player-counts', baseUrl)
  const http = url.protocol === 'https:' ? require('https') : require('http')

  const headers = {}
  if (apiKey) {
    headers['X-API-Key'] = apiKey
  }

  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(new Error('Invalid JSON from player-counts API'))
        }
      })
    })

    req.on('error', reject)

    // Set a manual timeout since http timeout only covers socket idle
    setTimeout(() => {
      req.destroy()
      reject(new Error('API request timed out'))
    }, timeout)
  })
}

function getCachedCounts (timeout) {
  const now = Date.now()
  if (_apiCachePromise && (now - _apiCacheTime) < config.rates.pingAll) {
    return _apiCachePromise
  }
  _apiCacheTime = now
  _apiCachePromise = fetchPlayerCounts(timeout).catch(err => {
    // Clear cache on error so next cycle retries
    _apiCachePromise = null
    throw err
  })
  return _apiCachePromise
}

function ping (serverRegistration, timeout, callback, version) {
  getCachedCounts(timeout)
    .then(counts => {
      const gameType = serverRegistration.data.gameType
      const playerCount = counts[gameType]

      callback(null, {
        players: {
          online: typeof playerCount === 'number' ? capPlayerCount(serverRegistration.data.ip, playerCount) : 0
        }
      })
    })
    .catch(err => callback(err))
}

// player count can be up to 1^32-1, which is a massive scale and destroys browser performance when rendering graphs
// Artificially cap and warn to prevent propogating garbage
function capPlayerCount (host, playerCount) {
  const maxPlayerCount = 250000

  if (playerCount !== Math.min(playerCount, maxPlayerCount)) {
    logger.log('warn', '%s returned a player count of %d, Minetrack has capped it to %d to prevent browser performance issues with graph rendering. If this is in error, please edit maxPlayerCount in ping.js!', host, playerCount, maxPlayerCount)

    return maxPlayerCount
  } else if (playerCount !== Math.max(playerCount, 0)) {
    logger.log('warn', '%s returned an invalid player count of %d, setting to 0.', host, playerCount)

    return 0
  }
  return playerCount
}

class PingController {
  constructor (app) {
    this._app = app
    this._isRunningTasks = false
  }

  schedule () {
    setInterval(this.pingAll, config.rates.pingAll)

    this.pingAll()
  }

  pingAll = () => {
    const { timestamp, updateHistoryGraph } = this._app.timeTracker.newPointTimestamp()

    this.startPingTasks(results => {
      const updates = []

      for (const serverRegistration of this._app.serverRegistrations) {
        const result = results[serverRegistration.serverId]

        // Log to database if enabled
        // Use null to represent a failed ping
        if (config.logToDatabase) {
          const unsafePlayerCount = getPlayerCountOrNull(result.resp)

          this._app.database.insertPing(serverRegistration.data.ip, timestamp, unsafePlayerCount)
        }

        // Generate a combined update payload
        // This includes any modified fields and flags used by the frontend
        // This will not be cached and can contain live metadata
        const update = serverRegistration.handlePing(timestamp, result.resp, result.err, result.version, updateHistoryGraph)

        updates[serverRegistration.serverId] = update
      }

      // Send object since updates uses serverIds as keys
      // Send a single timestamp entry since it is shared
      this._app.server.broadcast(MessageOf('updateServers', {
        timestamp: TimeTracker.toSeconds(timestamp),
        updateHistoryGraph,
        updates
      }))
    })
  }

  startPingTasks = (callback) => {
    if (this._isRunningTasks) {
      logger.log('warn', 'Started re-pinging servers before the last loop has finished! You may need to increase "rates.pingAll" in config.json')

      return
    }

    this._isRunningTasks = true

    const results = []

    for (const serverRegistration of this._app.serverRegistrations) {
      const version = serverRegistration.getNextProtocolVersion()

      ping(serverRegistration, config.rates.connectTimeout, (err, resp) => {
        if (err && config.logFailedPings !== false) {
          logger.log('error', 'Failed to ping %s: %s', serverRegistration.data.ip, err.message)
        }

        results[serverRegistration.serverId] = {
          resp,
          err,
          version
        }

        if (Object.keys(results).length === this._app.serverRegistrations.length) {
          // Loop has completed, release the locking flag
          this._isRunningTasks = false

          callback(results)
        }
      }, version.protocolId)
    }
  }
}

module.exports = PingController
