module.exports = enableDestroy;

/**
 * Track all active connections for a server, in order
 * that an orderly (and eventually forcible) shutdown of
 * those connections can be performed when retiring the server
 * @param server
 */
function enableDestroy(server) {
	var connections = {};

	server.on('connection', function (conn) {
		var key = conn.remoteAddress + ':' + conn.remotePort;
		connections[key] = conn;
		conn.on('close', function () {
			delete connections[key];
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
		if (server._handle)
			server.close(cb);
		for (var key in connections) {
			var connection = connections[key], serverResponse = connection._httpMessage;
			if(serverResponse)
				serverResponse._last = true;
			else
				connection.destroy();
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
