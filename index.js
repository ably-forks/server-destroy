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
 * @param policy: one of the following:
 *  - 'default': connections are handled according to the following rules:
 *    * in-progress HTTP requests are marked as being the last, so
 *      are responded with Connection: close, and the connection is closed
 *      on completion of the response.
 *    * idle persistent connections that have processed at least one
 *      http request are asynchronously closed immediately
 *    * ws connections are asynchronously closed immediately
 *    * connections that are open, but have not yet had an request started
 *      are held open until either a request is received (in which case they
 *      are then handled according to one of the other rules of this policy)
 *      or are finally abruptly destroyed when the destroy() event on the
 *      server occurs
 *  - 'passive': as for the default policy, with the following exception:
 *    * idle persistent connections that have processed at least one
 *      http request are held open until the next request is received, which
 *      then is marked as the last request. These are responded with
 *      Connection: close, and the connection is closed on completion of the
 *      response.
 *  - 'abrupt': all connections immediately destroyed when the server is suspended;
 */
function enableDestroy(server, policy) {
	policy = policy || 'default';

	var connections = {}, wsConnections = {};

	server.on('connection', function (conn) {
		var key = connectionKey(conn);
		connections[key] = conn;
		conn.on('close', function () {
			delete connections[key];
		});
	});

	server.on('upgrade', function(req, conn, upgradeHead) {
		var key = connectionKey(conn);
		wsConnections[key] = conn;
		conn.on('close', function () {
			delete wsConnections[key];
		});
	});

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
	server.suspend = function (cb) {
		/* stop accepting new connections */
		if(server._handle)
			server.close(cb);

		/* process extant connections */
		var hasUncommittedConnections = false;
		for (var key in connections) {
			var connection = connections[key];

			/* under the abrupt policy all connections are closed immediately */
			if(policy == 'abrupt') {
				connection.destroy();
				return;
			}

			/* classify this connection */
			var serverResponse = connection._httpMessage,
				isWsConnection = (key in wsConnections),
				isHTTPConnection = (serverResponse !== undefined),
				isInProgress = !!serverResponse,
				isUncommitted = !isWsConnection && !isHTTPConnection;

			/* ws connections are always destroyed immediately */
			if(isWsConnection) {
				connection.destroy();
				return;
			}

			if(isHTTPConnection) {
				if(isInProgress) {
					/* in progress connections are marked as being the end
					 * of the persistent connection */
					serverResponse.shouldKeepAlive = false;
				} else if(policy == 'default') {
					/* these are idle persistent HTTP connections, which
					 * are closed now under the default policy */
					connection.destroy();
				}
				return;
			}

			/* any remaining connection is uncommitted */
			hasUncommittedConnections = true;
		}

		if(hasUncommittedConnections) {
			/* any incoming requests on the uncommitted connections
			 * must be marked as last */
			server.on('request', function(req, res) {
				res.shouldKeepAlive = false;
			});

			/* any new ws upgrade requests are terminated */
			server.on('upgrade', function(req, conn) {
				conn.destroy();
			});
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
		if (server._handle)
			server.close(cb);
		for (var key in connections)
			connections[key].destroy();
	};
}
