// NetProxy - Browser client for WebSocket-to-TCP proxy
// SPDX-License-Identifier: MIT

'use strict';

/**
 * NetProxy - Browser client for WebSocket-to-TCP proxy
 *
 * Usage:
 *   const proxy = new NetProxy('wss://your-server.com', {
 *     authToken: 'jwt-token-here'  // optional
 *   });
 *
 *   const connId = await proxy.open('example.com', 80);
 *   proxy.write(connId, new Uint8Array([...]));
 *   proxy.onData(connId, (data) => console.log(data));
 *   proxy.close(connId);
 */
class NetProxy {
  constructor(wsUrl, options = {}) {
    this.wsUrl = wsUrl;
    this.options = options;
    this.ws = null;
    this.connections = new Map();  // connId -> { callbacks, buffer, closed, error }
    this.pendingOpens = new Map(); // connId -> { resolve, reject }
    this.nextConnId = 1;
    this.connected = false;
    this.connectPromise = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
  }

  /**
   * Ensure WebSocket is connected
   */
  async ensureConnected() {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      // Build URL with auth token if provided
      let url = this.wsUrl;
      if (this.options.authToken) {
        const separator = url.includes('?') ? '&' : '?';
        url = `${url}${separator}token=${encodeURIComponent(this.options.authToken)}`;
      }

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.connected = true;
        this.connectPromise = null;
        this.reconnectAttempts = 0;
        console.log('[NetProxy] Connected to', this.wsUrl);
        resolve();
      };

      this.ws.onerror = (err) => {
        this.connected = false;
        this.connectPromise = null;
        console.error('[NetProxy] WebSocket error:', err);
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        this.connectPromise = null;
        console.log('[NetProxy] Disconnected:', event.code, event.reason);

        // Notify all connections of close
        for (const [connId, conn] of this.connections) {
          conn.closed = true;
          if (conn.onClose) {
            conn.onClose();
          }
        }
        this.connections.clear();

        // Reject pending opens
        for (const [connId, pending] of this.pendingOpens) {
          pending.reject(new Error('WebSocket closed'));
        }
        this.pendingOpens.clear();
      };

      this.ws.onmessage = (event) => {
        try {
          this.handleMessage(JSON.parse(event.data));
        } catch (err) {
          console.error('[NetProxy] Failed to parse message:', err);
        }
      };
    });

    return this.connectPromise;
  }

  /**
   * Handle incoming WebSocket message
   */
  handleMessage(msg) {
    switch (msg.t) {
      case 'opened': {
        const pending = this.pendingOpens.get(msg.id);
        if (pending) {
          this.pendingOpens.delete(msg.id);
          this.connections.set(msg.id, {
            buffer: [],
            closed: false,
            error: null,
            onData: null,
            onClose: null,
            onError: null,
          });
          pending.resolve(msg.id);
        }
        break;
      }

      case 'data': {
        const conn = this.connections.get(msg.id);
        if (conn) {
          const data = this.base64ToUint8Array(msg.b64);
          if (conn.onData) {
            conn.onData(data);
          } else {
            conn.buffer.push(data);
          }
        }
        break;
      }

      case 'closed': {
        const conn = this.connections.get(msg.id);
        if (conn) {
          conn.closed = true;
          if (conn.onClose) {
            conn.onClose();
          }
        }
        break;
      }

      case 'error': {
        // Could be for pending open or existing connection
        const pending = this.pendingOpens.get(msg.id);
        if (pending) {
          this.pendingOpens.delete(msg.id);
          pending.reject(new Error(msg.msg));
        } else {
          const conn = this.connections.get(msg.id);
          if (conn) {
            conn.error = msg.msg;
            if (conn.onError) {
              conn.onError(new Error(msg.msg));
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Open a new TCP connection through the proxy
   * @param {string} host - Target hostname
   * @param {number} port - Target port (must be in allowlist: 80, 443)
   * @returns {Promise<number>} - Connection ID
   */
  async open(host, port) {
    await this.ensureConnected();

    const id = this.nextConnId++;

    return new Promise((resolve, reject) => {
      this.pendingOpens.set(id, { resolve, reject });

      this.ws.send(JSON.stringify({
        t: 'open',
        id,
        host,
        port,
      }));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingOpens.has(id)) {
          this.pendingOpens.delete(id);
          reject(new Error('Connection timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Write data to a connection
   * @param {number} connId - Connection ID from open()
   * @param {Uint8Array|string} data - Data to send
   */
  write(connId, data) {
    if (!this.connections.has(connId)) {
      throw new Error(`Connection ${connId} not found`);
    }

    // Convert string to Uint8Array if needed
    if (typeof data === 'string') {
      data = new TextEncoder().encode(data);
    }

    const b64 = this.uint8ArrayToBase64(data);

    this.ws.send(JSON.stringify({
      t: 'write',
      id: connId,
      b64,
    }));
  }

  /**
   * Set callback for incoming data
   * @param {number} connId - Connection ID
   * @param {function} callback - Called with Uint8Array when data arrives
   */
  onData(connId, callback) {
    const conn = this.connections.get(connId);
    if (!conn) {
      throw new Error(`Connection ${connId} not found`);
    }

    conn.onData = callback;

    // Flush any buffered data
    while (conn.buffer.length > 0) {
      callback(conn.buffer.shift());
    }
  }

  /**
   * Set callback for connection close
   * @param {number} connId - Connection ID
   * @param {function} callback - Called when connection closes
   */
  onClose(connId, callback) {
    const conn = this.connections.get(connId);
    if (conn) {
      conn.onClose = callback;
      // If already closed, call immediately
      if (conn.closed) {
        callback();
      }
    }
  }

  /**
   * Set callback for connection errors
   * @param {number} connId - Connection ID
   * @param {function} callback - Called with Error on error
   */
  onError(connId, callback) {
    const conn = this.connections.get(connId);
    if (conn) {
      conn.onError = callback;
      // If already errored, call immediately
      if (conn.error) {
        callback(new Error(conn.error));
      }
    }
  }

  /**
   * Close a connection
   * @param {number} connId - Connection ID
   */
  close(connId) {
    if (!this.connections.has(connId)) {
      return;
    }

    this.ws.send(JSON.stringify({
      t: 'close',
      id: connId,
    }));

    this.connections.delete(connId);
  }

  /**
   * Read buffered data synchronously
   * @param {number} connId - Connection ID
   * @returns {Uint8Array|null} - Buffered data or null if none
   */
  readBuffered(connId) {
    const conn = this.connections.get(connId);
    if (!conn || conn.buffer.length === 0) {
      return null;
    }

    // Concatenate all buffered chunks
    const totalLen = conn.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;

    for (const chunk of conn.buffer) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    conn.buffer = [];
    return result;
  }

  /**
   * Check if connection has buffered data
   * @param {number} connId - Connection ID
   * @returns {boolean}
   */
  hasData(connId) {
    const conn = this.connections.get(connId);
    return conn && conn.buffer.length > 0;
  }

  /**
   * Check if connection is still open
   * @param {number} connId - Connection ID
   * @returns {boolean}
   */
  isOpen(connId) {
    const conn = this.connections.get(connId);
    return conn && !conn.closed && !conn.error;
  }

  /**
   * Check if connection is closed
   * @param {number} connId - Connection ID
   * @returns {boolean}
   */
  isClosed(connId) {
    const conn = this.connections.get(connId);
    return !conn || conn.closed;
  }

  /**
   * Get connection error if any
   * @param {number} connId - Connection ID
   * @returns {string|null}
   */
  getError(connId) {
    const conn = this.connections.get(connId);
    return conn ? conn.error : null;
  }

  /**
   * Disconnect from proxy server
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.connections.clear();
    this.pendingOpens.clear();
  }

  // =========================================================================
  // Utility methods
  // =========================================================================

  uint8ArrayToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NetProxy;
}
