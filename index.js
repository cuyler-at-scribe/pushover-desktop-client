var ws = require('ws')
  , fs = require('fs')
  , querystring = require('querystring')
  , https = require('https')
  , Notification = require('node-notifier')
  , path = require('path')
  , os = require('os')

/**
 * Handles everything for showing Pushover notifications, just call #connect()
 *
 * @param {Object} settings Instance configuration
 * @param {String} settings.deviceId The device id for your Pushover notification stream
 * @param {String} settings.secret The secret for your Pushover notification stream
 * @param {String} [settings.imageCache=null] Path to the image cache directory, used for app icons
 * @param {String} [settings.wsHost='wss://client.pushover.net/push'] Pushover websocket host to connect to
 * @param {String} [settings.iconHost='client.pushover.net'] Pushover icon host
 * @param {String} [settings.apiHost='api.pushover.net'] Pushover API host
 * @param {String} [settings.apiPath='/1'] Pushover API version, mostly
 * @param {Number} [settings.keepAliveTimeout=60000] Time to wait for a keep alive message before considering the
 *      connection dead, also used for connection attempt rate limiting
 * @param {Object} [settings.notifier=Notification] Notification subsystem to use, mostly here for test support
 * @param {Object} [settings.https=https] https lib to use, mostly here for test support
 * @param {Object} [settings.logger=console] logger to use, mostly here for test support
 * @param {String} [settings.stateFile] Path to the state file for persistence
 *
 * @constructor
 */
var Client = function (settings) {
    this.settings = settings

    this.settings.wsHost = settings.wsHost || 'wss://client.pushover.net/push'
    this.settings.iconHost = settings.iconHost || 'client.pushover.net'
    this.settings.apiHost = settings.apiHost || 'api.pushover.net'
    this.settings.apiPath = settings.apiPath || '/1'
    this.settings.keepAliveTimeout = settings.keepAliveTimeout || 60000

    // Maximum time to wait for any HTTPS request before failing (ms)
    this.settings.requestTimeout = settings.requestTimeout || 10000

    // Reduced default poll interval to 30 s so we re-sync faster if a socket
    // event is missed.
    this.settings.pollInterval = settings.pollInterval || 30000

    this.notifier = settings.notifier || Notification
    this.https = settings.https || https
    this.logger = settings.logger || console

    // --- Persistence for highest processed message (item 2) ---
    this.stateFile = settings.stateFile || path.join(
        settings.imageCache || process.cwd(),
        '.pushover_state.json'
    )

    try {
        var persisted = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
        this._headFromState = typeof persisted.highest === 'number' ? persisted.highest : null
    } catch (e) {
        this._headFromState = null
    }

    // helper for saving state
    this._saveLastProcessed = function (id) {
        if (!id) { return }
        try {
            fs.writeFileSync(this.stateFile, JSON.stringify({ highest: id }), 'utf8')
        } catch (err) {
            // Non-fatal: just log
            this.logger.error('Failed to persist state file', err.stack || err)
        }
    }
}

module.exports = Client

/**
 * Handles the websocket connection
 * Sets up triggered message refreshing as well as an initial refresh to ensure we haven't missed anything
 */
Client.prototype.connect = function () {
    var self = this

    if (self.wsClient) {
        return
    }

    var wsClient = new ws(self.settings.wsHost)

    self._lastConnection = Date.now()

    wsClient.on('open', function () {
        // If we crashed before deleting messages from the server, clean up first
        if (self._headFromState) {
            self.updateHead({ id: self._headFromState })
        }

        self.refreshMessages()
        self.logger.log('Websocket client connected, waiting for new messages')
        self.resetKeepAlive()
        wsClient.send('login:' + self.settings.deviceId + ':' + self.settings.secret + '\n')

        // Kick off a periodic sync in case network hiccups drop websocket events
        clearInterval(self._pollInterval)
        self._pollInterval = setInterval(function () {
            self.refreshMessages()
        }, self.settings.pollInterval)
    })

    wsClient.on('message', function (event) {
        console.log('cuyler: rcvd new message event')

        var message = event.toString('utf8')

        switch (message) {
            // New message available – trigger sync
            case '!':
                self.logger.log('Got new message event')
                return self.refreshMessages()

            // Keep-alive ping
            case '#':
                self.resetKeepAlive()
                return

            // Reload request – drop and reconnect
            case 'R':
                self.logger.warn('Server requested reload – reconnecting')
                return self.reconnect()

            // Permanent error – log and attempt a manual sync so we don't miss data
            case 'E':
                self.logger.error('Server sent error frame – performing manual sync')
                self.refreshMessages()
                return

            // Another session logged in – 'A'. Follow current behaviour: reconnect later
            case 'A':
                self.logger.warn('Session closed because of another login (A)')
                return self.reconnect()

            default:
                self.logger.error('Unknown message frame:', message)
                self.reconnect()
        }
    })

    wsClient.on('error', function (error) {
        self.logger.error('Websocket connection error')
        self.logger.error(error.stack || error)
        self.reconnect()
    })

    wsClient.on('close', function () {
        self.logger.log('Websocket connection closed, reconnecting')
        self.reconnect()
    })

    self.wsClient = wsClient
}

/**
 * Resets the websocket client termination timer
 * If the timer isn't reset in time the websocket client is reconnected
 */
Client.prototype.resetKeepAlive = function () {
    var self = this

    clearTimeout(self._keepAlive)

    self._keepAlive = setTimeout(function () {
        self.logger.error('Did not receive a keep alive message in time, closing connection')
        self.reconnect()
    }, self.settings.keepAliveTimeout)
}

/**
 * Handles clearing the old websocket client and reconnecting
 * Avoids spamming the websocket server
 */
Client.prototype.reconnect = function () {
    var self = this

    clearTimeout(self._keepAlive)

    try {
        self.wsClient.removeAllListeners()
        self.wsClient.terminate()
        self.wsClient = null
    } catch (e) {}

    clearInterval(self._pollInterval)

    self._reconnect = setTimeout(function () {
        clearTimeout(self._reconnect)
        self.connect()
    }, self.settings.keepAliveTimeout - (Date.now() - self._lastConnection))
}

/**
 * Makes an https request to Pushover to get all messages we haven't seen yet
 * Notifications will be generated for any new messages
 */
Client.prototype.refreshMessages = function () {
    console.log('cuyler: refreshMessages')
    var self = this

    self.logger.log('Refreshing messages')

    var options = {
        host: self.settings.apiHost
      , method: 'GET'
      , path: self.settings.apiPath + '/messages.json?' + querystring.stringify({
            secret: self.settings.secret
          , device_id: self.settings.deviceId
        })
    }

    var request = self.https.request(options, function (response) {
        var finalData = ''

        response.on('data', function (data) {
            finalData += data.toString()
        })

        response.on('end', function () {
            if (response.statusCode !== 200) {
                self.logger.error('Error while refreshing messages')
                self.logger.error(finalData)
                return
            }

            try {
                var payload = JSON.parse(finalData)
                console.log('cuyler: payload', payload)
                self.notify(payload.messages)
            } catch (error) {
                self.logger.error('Failed to parse message payload')
                self.logger.error(error.stack || error)
            }
        })

        // Fail fast on very bad connectivity – allows retry via next poll cycle
        request.setTimeout(self.settings.requestTimeout, function () {
            self.logger.error('Timeout while refreshing messages (>' + self.settings.requestTimeout + 'ms)')
            request.abort()
        })
    })

    request.on('error', function (error) {
        self.logger.error('Error while refreshing messages')
        self.logger.error(error.stack || error)
    })

    request.end()
}

/**
 * Takes a list of message, prepares them, and sends to the notify subsystem
 * After all notifications are processed updateHead is called to clear them from Pushover for the configured deviceId
 *
 * @param {Client~PushoverMessage[]} messages A list of pushover message objects
 */
Client.prototype.notify = function (messages) {
    // Track the last message that was *successfully* notified so we only
    // advance the server head once we know the user has seen it.
    var self = this,
        lastSuccessful = null,
        useMessages = messages

    var next = function () {
        var message = useMessages.shift(),
            icon

        // No more messages – advance head to the last confirmed success (if any)
        if (!message) {
            self.updateHead(lastSuccessful)
            return
        }

        if (message.icon) {
            icon = message.icon + '.png'
        } else if (message.aid === 1) {
            icon = 'pushover.png'
        } else {
            icon = 'default.png'
        }

        try {
            self.fetchImage(icon, function (imageFile) {
                var payload = {}

                if (imageFile) {
                    // Only include icon fields when we actually have an image path
                    payload.appIcon = imageFile
                    payload.icon = imageFile
                }

                payload.title = message.title || message.app

                if (message.message) {
                    payload.message = message.message
                }

                self.logger.log('Sending notification for', message.id)

                try {
                    self.notifier.notify(payload, function (error) {
                        if (error) {
                            self.logger.error('Returned error while trying to send the notification')
                            self.logger.error(error.stack || error)
                        } else {
                            // Mark this message as successfully processed
                            lastSuccessful = message
                            self._saveLastProcessed(message.id)
                        }

                        // Continue with the next message regardless of success
                        next()
                    })
                } catch (error) {
                    self.logger.error('Caught error while trying to send the notification')
                    self.logger.error(error.stack || error)
                    next()
                }
            })
        } catch (error) {
            self.logger.error('Caught error while trying to fetch the image')
            self.logger.error(error.stack || error)
            next()
        }
    }

    next()
}

/**
 * Fetches an image from Pushover and stuffs it in a cache dir
 * If the image already exists in the cache dir the fetch is skipped
 *
 * @param {String} imageName The name of the image, from the message object
 * @param {Client~FetchCallback} callback A function to call once this has completed, the image path is provided or false if no
 *      image could be fetched
 */
Client.prototype.fetchImage = function (imageName, callback) {
    var self = this

    if (!self.settings.imageCache) {
        return callback(false)
    }

    var imageFile = path.join(self.settings.imageCache, imageName)
    if (fs.existsSync(imageFile)) {
        return callback(imageFile)
    }

    self.logger.log('Caching image for', imageName)

    var options = {
        host: self.settings.iconHost
      , method: 'GET'
      , path: '/icons/' + imageName
    }

    var request = self.https.request(options, function (response) {
        try {
            response.pipe(fs.createWriteStream(imageFile))
        } catch (error) {
            self.logger.error('FS error while caching image', imageName)
            self.logger.error(error.stack || error)
            return callback(false)
        }

        response.on('end', function () {
            if (response.statusCode !== 200) {
                self.logger.error('HTTP error while caching image', imageName, 'statusCode:', response.statusCode)
                return callback(false)
            }

            callback(imageFile)
        })

        // Fail fast on very bad connectivity – allows retry via next poll cycle
        request.setTimeout(self.settings.requestTimeout, function () {
            self.logger.error('Timeout while caching image', imageName)
            request.abort()
            callback(false)
        })
    })

    request.on('error', function (error) {
        self.logger.error('Request error while caching image', imageName)
        self.logger.error(error.stack || error)
        callback(false)
    })

    request.end()
}

/**
 * Updates the last seen message with Pushover
 * Any messages below this id will *not* be re-synced
 *
 * @param {Client~PushoverMessage} message The last message received from an update
 */
Client.prototype.updateHead = function (message) {
    var self = this

    if (!message) {
        return
    }

    self.logger.log('Updating head position to', message.id)

    var options = {
        host: self.settings.apiHost
      , method: 'POST'
      , path: self.settings.apiPath + '/devices/' + self.settings.deviceId + '/update_highest_message.json'
    }

    var request = self.https.request(options, function (response) {
        var finalData = ''

        response.on('data', function (data) {
            finalData += data.toString()
        })

        response.on('end', function () {
            if (response.statusCode !== 200) {
                self.logger.error('Error while updating head')
                self.logger.error(finalData)
            }
        })

    })

    request.on('error', function (error) {
        self.logger.error('Error while refreshing messages')
        self.logger.error(error.stack || error)
    })

    request.write(querystring.stringify({
        secret: self.settings.secret
      , message: message.id
    }) + '\n')

    request.end()
}

/**
 * A Pushover message
 * Contains everything needed to prepare and display a notification
 *
 * @typedef {Object} Client~PushoverMessage
 *
 * @property {Number} id Unique ID of the message
 * @property {String} message Actual message to be displayed
 * @property {String} app Name of the app that send the message
 * @property {Number} aid Id of the app that sent the message
 * @property {String} icon Name of the icon for the app that sent the message.
 *      Seems to always be a png on Pushovers servers
 * @property {Number} date Unix time stamp representing the date the message was sent
 * @property {Number} priority Message priority
 * @property {Number} acked Whether or not the message has been acked by some other client
 * @property {Number} umid No idea
 */

/**
 * @callback Client~FetchCallback
 *
 * @param {String|boolean} Either the path to the image on disk or false if no image could be provided
 */
