module.exports = enableDestroy;

/**
 * Track all active connections for a server, in order
 * that an orderly (and eventually forcible) shutdown of
 * those connections can be performed when retiring the server
 * @param server
 */

/**
 * Generate a unique key for a given connection
 * @param conn
 * @returns {string}
 */
function connectionKey(conn) {
	return conn.remoteAddress + ':' + conn.remotePort;
}

/**
 * Enable a server to have a controllable shutdown
 * @param server: the http server
 * @param options: an object containing options for shutdown:
 * - policy: one of the following:
 *    - 'default': connections are handled according to the following rules:
 *      * in-progress HTTP requests are marked as being the last, so
 *        are responded with Connection: close, and the connection is closed
 *        on completion of the response.
 *      * idle persistent connections that have processed at least one
 *        http request are asynchronously closed immediately
 *      * ws connections are asynchronously closed immediately
 *      * connections that are open, but have not yet had an request started
 *        are held open until either a request is received (in which case they
 *        are then handled according to one of the other rules of this policy)
 *        or are finally abruptly destroyed when the destroy() event on the
 *        server occurs
 *    - 'prefer_sync': as for the default policy, but minimising the extent to which
 *      persistent http connections are closed asynchronously, preferring closing
 *      synchronously (with Connection:close) at the end of the next request.
 *      This policy also suports permitting new persistent connections for a short
 *      grace period, to cope with proxies that are unable to react dynamically to
 *      this upstream server refusing new connections to service existing client
 *      connections already implicitly associated with this server. (Hint: nginx)
 *      Under this policy, any idle persistent connections that have processed at
 *      least one http request are held open until the next request is received,
 *      which then is marked as the last request. These are responded with
 *      Connection: close, and the connection is closed on completion of the
 *      response.
 *    - 'abrupt': all connections immediately destroyed when the server is suspended;
 *
 *  - 'closeIdleConnections': the time in millis for which idle persistent http
 *     connections (under the prefer_sync policy) and uncommitted connections are
 *     maintained before closing asynchronously
 *
 *  - 'allowNewConnections': the time in millis for which new http connections are
 *     allowed to be created
 *
 *  - 'shedWsConnections': the time in millis over which websocket connections are
 *     closed (to avoid the consequent flood of reconnections if all are closed
 *     simultaneously)
 */
function enableDestroy(server, options) {
	var policy = (options && options.policy) || 'default',
		closeIdleConnections = (options && options.closeIdleConnections) || 0,
		allowNewConnections = (options && options.allowNewConnections) || 0,
		shedWsConnections = (options && options.shedWsConnections) || 0,
		connections = {},
		wsConnections = {};

	function connectionListener(conn) {
		var key = connectionKey(conn);
		connections[key] = conn;
		conn.on('close', function() {
			delete connections[key];
		});
	};

	server.on('connection', connectionListener);

	function upgradeListener(req, conn, upgradeHead) {
		var key = connectionKey(conn);
		wsConnections[key] = conn;
		conn.on('close', function() {
			delete wsConnections[key];
		});
	};

	server.on('upgrade', upgradeListener);

	function destroyConnections(connectionIds) {
		connectionIds.forEach(function(id) {
			connections[id].destroy();
		});
	}

	function shedConnections(connectionIds, interval) {
		var iterations = 16,
			connectionsPerIteration = Math.ceil(connectionIds.length / iterations);

		var intervalTimer = setInterval(function() {
			var connectionsThisIteration;
			if(--iterations == 0) {
				clearInterval(intervalTimer);
				connectionsThisIteration = connectionIds;
			} else {
				connectionsThisIteration = connectionIds.splice(0, connectionsPerIteration);
			}
			destroyConnections(connectionsThisIteration);
		}, Math.floor(interval / iterations));
	}

	function closeListener() {
		if(server._handle) server.close();
	}

	/**
	 * Add a suspend() method to the server which:
	 * - removes the listener, so no new connections are created;
	 * - kills all extant connections that do not currently have
	 *   an HTTP ServerResponse associated with them (note that
	 *   this will include Websocket connections);
	 * - labels all other connections in a way that ensures that
	 *   they are closed by the server as soon as the present HTTP
	 *   request is complete.
	 * @param cb
	 */
	server.suspend = function() {

		/*************************
		 * abrupt policy
		 *************************/

		if(policy == 'abrupt') {
			destroyConnections(Object.keys(connections));
			closeListener();
			return;
		}

		/*************************
		 * listener
		 *************************/

		setTimeout(closeListener, allowNewConnections);

		/*************************
		 * websocket connections
		 *************************/

		/* close existing connections */
		var wsConnectionIds = Object.keys(wsConnections);
		if(shedWsConnections == 0)
			destroyConnections(wsConnectionIds);
		else
			shedConnections(wsConnectionIds, shedWsConnections);

		/* any new ws upgrade requests are terminated */
		server.removeListener('upgrade', upgradeListener);
		server.on('upgrade', function(req, conn) {
			conn.destroy();
		});

		/*************************
		 * HTTP connections
		 *************************/

		for(var key in connections) {
			if(key in wsConnections) continue;

			/* if there has never been a server response, it's uncommitted */
			var connection = connections[key], serverResponse = connection._httpMessage;
			if(serverResponse === undefined) continue;

			/* handle based on whether or not there is a request in progress */
			if(serverResponse) {
				/* in-progress connections are marked as being the end
				 * of the persistent connection */
				serverResponse.shouldKeepAlive = false;
			} else if(policy == 'default') {
				/* this is an idle persistent HTTP connection, which
				 * are closed now asynchronously under the default policy */
				connection.destroy();
			}
		}

		/* any incoming requests on uncommitted or new connections
		 * must be marked as last */
		server.on('request', function(req, res) {
			res.shouldKeepAlive = false;
		});

		/* close existing idle and uncommmitted connections */
		if(closeIdleConnections > 0) {
			setTimeout(function() {
				for(var key in connections) {
					if(key in wsConnections) continue;

					/* unless there is a request in progress, destroy now */
					var connection = connections[key], serverResponse = connection._httpMessage;
					if(!serverResponse) {
						connection.destroy();
					}
				}
			}, closeIdleConnections);
		}
	};

	/**
	 * Add a destroy() method to the server which:
	 * - removes the listener, so no new connections are created;
	 * - kills all extant connections (including those that still
	 *   have in-flight requests).
	 * @param cb
	 */
	server.destroy = function (cb) {
		closeListener();
		destroyConnections(Object.keys(connections));
	};
}
