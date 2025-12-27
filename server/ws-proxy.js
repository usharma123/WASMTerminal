// WebSocket-to-TCP Proxy Server for linux-wasm networking
// SPDX-License-Identifier: MIT
//
// SECURITY NOTICE: This server creates SSRF risks. All security
// measures implemented here are MANDATORY. Do not disable them.

'use strict';

const WebSocket = require('ws');
const http = require('http');
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const crypto = require('crypto');

let jwt;
try {
  jwt = require('jsonwebtoken');
} catch (e) {
  console.warn('jsonwebtoken not installed, JWT auth disabled');
}

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  port: parseInt(process.env.PORT || '8080', 10),

  auth: {
    enabled: process.env.AUTH_ENABLED !== 'false',
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  },

  // SECURITY: Port allowlist - ONLY allow these ports
  allowedPorts: [80, 443],

  // SECURITY: Blocked IP ranges (CIDR notation)
  blockedCIDRs: [
    '10.0.0.0/8',           // Private Class A
    '172.16.0.0/12',        // Private Class B
    '192.168.0.0/16',       // Private Class C
    '127.0.0.0/8',          // Loopback
    '169.254.0.0/16',       // Link-local
    '0.0.0.0/8',            // Invalid
    '224.0.0.0/4',          // Multicast
    '240.0.0.0/4',          // Reserved
    '100.64.0.0/10',        // Carrier-grade NAT
    '169.254.169.254/32',   // Cloud metadata (AWS, GCP, Azure)
  ],

  // Rate limits
  rateLimits: {
    bytesPerMinute: 10 * 1024 * 1024,  // 10 MB/min
    connectionsPerMinute: 30,
    maxConcurrentConnections: 5,
    connectionTimeout: 30000,           // 30 seconds
    idleTimeout: 60000,                 // 1 minute
  },

  // DNS rebinding protection
  dnsCache: {
    enabled: true,
    ttl: 300000,  // 5 minutes
  },
};

// =============================================================================
// IP Validator - Block private/internal IP ranges
// =============================================================================

class IPValidator {
  constructor(blockedCIDRs) {
    this.blockedRanges = blockedCIDRs.map(cidr => this.parseCIDR(cidr));
  }

  parseCIDR(cidr) {
    const [ip, prefixLen] = cidr.split('/');
    const prefix = parseInt(prefixLen, 10);
    const parts = ip.split('.').map(n => parseInt(n, 10));
    return { parts, prefix };
  }

  isBlocked(ip) {
    // Handle IPv4-mapped IPv6 addresses
    if (ip.startsWith('::ffff:')) {
      ip = ip.substring(7);
    }

    // Only handle IPv4 for now
    if (ip.includes(':')) {
      // Block all IPv6 private ranges
      if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) {
        return true;
      }
      return false;
    }

    const parts = ip.split('.').map(n => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) {
      return true; // Invalid IP, block it
    }

    for (const range of this.blockedRanges) {
      if (this.matchesCIDR(parts, range.parts, range.prefix)) {
        return true;
      }
    }

    return false;
  }

  matchesCIDR(ip, rangeIp, prefix) {
    const ipNum = (ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3];
    const rangeNum = (rangeIp[0] << 24) | (rangeIp[1] << 16) | (rangeIp[2] << 8) | rangeIp[3];
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
  }
}

// =============================================================================
// Rate Limiter
// =============================================================================

class RateLimiter {
  constructor(config) {
    this.config = config;
    this.userStats = new Map();
  }

  getStats(userId) {
    if (!this.userStats.has(userId)) {
      this.userStats.set(userId, {
        bytesThisMinute: 0,
        connectionsThisMinute: 0,
        activeConnections: 0,
        lastReset: Date.now(),
      });
    }

    const stats = this.userStats.get(userId);

    // Reset counters every minute
    if (Date.now() - stats.lastReset > 60000) {
      stats.bytesThisMinute = 0;
      stats.connectionsThisMinute = 0;
      stats.lastReset = Date.now();
    }

    return stats;
  }

  canConnect(userId) {
    const stats = this.getStats(userId);

    if (stats.connectionsThisMinute >= this.config.connectionsPerMinute) {
      return { allowed: false, reason: 'Connection rate limit exceeded' };
    }

    if (stats.activeConnections >= this.config.maxConcurrentConnections) {
      return { allowed: false, reason: 'Max concurrent connections exceeded' };
    }

    return { allowed: true };
  }

  canTransfer(userId, bytes) {
    const stats = this.getStats(userId);

    if (stats.bytesThisMinute + bytes > this.config.bytesPerMinute) {
      return { allowed: false, reason: 'Bandwidth limit exceeded' };
    }

    return { allowed: true };
  }

  recordConnection(userId) {
    const stats = this.getStats(userId);
    stats.connectionsThisMinute++;
    stats.activeConnections++;
  }

  recordDisconnection(userId) {
    const stats = this.getStats(userId);
    stats.activeConnections = Math.max(0, stats.activeConnections - 1);
  }

  recordBytes(userId, bytes) {
    const stats = this.getStats(userId);
    stats.bytesThisMinute += bytes;
  }
}

// =============================================================================
// DNS Resolver with caching and validation
// =============================================================================

class DNSResolver {
  constructor(config, ipValidator) {
    this.config = config;
    this.ipValidator = ipValidator;
    this.cache = new Map();
  }

  async resolveAndValidate(hostname) {
    // Check cache
    if (this.config.enabled) {
      const cached = this.cache.get(hostname);
      if (cached && Date.now() - cached.timestamp < this.config.ttl) {
        return cached.result;
      }
    }

    // Resolve DNS
    let addresses;
    try {
      addresses = await dns.resolve4(hostname);
    } catch (err) {
      throw new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
    }

    if (!addresses || addresses.length === 0) {
      throw new Error(`No addresses found for ${hostname}`);
    }

    const ip = addresses[0];

    // CRITICAL: Validate IP is not in blocked ranges
    if (this.ipValidator.isBlocked(ip)) {
      throw new Error(`Blocked IP address: ${ip} (resolved from ${hostname})`);
    }

    const result = { ip, hostname };

    if (this.config.enabled) {
      this.cache.set(hostname, { result, timestamp: Date.now() });
    }

    return result;
  }
}

// =============================================================================
// Authenticator
// =============================================================================

class Authenticator {
  constructor(config) {
    this.config = config;
  }

  authenticate(request) {
    if (!this.config.enabled) {
      return { authenticated: true, userId: 'anonymous' };
    }

    // Try JWT from query parameter (WebSocket can't set headers easily)
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token');

    if (token && jwt) {
      try {
        const decoded = jwt.verify(token, this.config.jwtSecret);
        return { authenticated: true, userId: decoded.sub || decoded.userId || 'jwt-user' };
      } catch (err) {
        return { authenticated: false, error: 'Invalid JWT token' };
      }
    }

    // Try Authorization header
    const authHeader = request.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ') && jwt) {
      const headerToken = authHeader.substring(7);
      try {
        const decoded = jwt.verify(headerToken, this.config.jwtSecret);
        return { authenticated: true, userId: decoded.sub || decoded.userId || 'jwt-user' };
      } catch (err) {
        return { authenticated: false, error: 'Invalid JWT token' };
      }
    }

    return { authenticated: false, error: 'No valid authentication provided' };
  }
}

// =============================================================================
// Logger
// =============================================================================

class Logger {
  log(level, userId, action, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      userId,
      action,
      ...details,
    };
    console.log(JSON.stringify(entry));
  }

  info(userId, action, details) {
    this.log('INFO', userId, action, details);
  }

  error(userId, action, error) {
    this.log('ERROR', userId, action, { error: error.message || error });
  }
}

// =============================================================================
// WebSocket Proxy Server
// =============================================================================

class WSProxyServer {
  constructor(config) {
    this.config = config;
    this.ipValidator = new IPValidator(config.blockedCIDRs);
    this.rateLimiter = new RateLimiter(config.rateLimits);
    this.dnsResolver = new DNSResolver(config.dnsCache, this.ipValidator);
    this.authenticator = new Authenticator(config.auth);
    this.logger = new Logger();
  }

  start() {
    const server = http.createServer((req, res) => {
      // Health check endpoint
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
      }

      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization',
        });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    const wss = new WebSocket.Server({ server });

    wss.on('connection', (ws, request) => this.handleConnection(ws, request));

    server.listen(this.config.port, () => {
      console.log(`WebSocket proxy server listening on port ${this.config.port}`);
      console.log(`Auth enabled: ${this.config.auth.enabled}`);
      console.log(`Allowed ports: ${this.config.allowedPorts.join(', ')}`);

      if (this.config.auth.jwtSecret === 'dev-secret-change-in-production') {
        console.warn('WARNING: Using default JWT secret. Set JWT_SECRET in production!');
      }
    });

    return server;
  }

  handleConnection(ws, request) {
    // Authenticate
    const auth = this.authenticator.authenticate(request);
    if (!auth.authenticated) {
      this.logger.error('unknown', 'AUTH_FAILED', new Error(auth.error));
      ws.close(4001, auth.error);
      return;
    }

    const userId = auth.userId;
    const clientConnections = new Map();

    this.logger.info(userId, 'WS_CONNECTED', { ip: request.socket.remoteAddress });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await this.handleMessage(ws, userId, msg, clientConnections);
      } catch (err) {
        this.logger.error(userId, 'MESSAGE_ERROR', err);
        ws.send(JSON.stringify({ t: 'error', msg: err.message }));
      }
    });

    ws.on('close', () => {
      this.logger.info(userId, 'WS_DISCONNECTED', {});

      // Clean up all TCP connections
      for (const [connId, conn] of clientConnections) {
        if (conn.socket) {
          conn.socket.destroy();
        }
        this.rateLimiter.recordDisconnection(userId);
      }
      clientConnections.clear();
    });

    ws.on('error', (err) => {
      this.logger.error(userId, 'WS_ERROR', err);
    });
  }

  async handleMessage(ws, userId, msg, clientConnections) {
    switch (msg.t) {
      case 'open':
        await this.handleOpen(ws, userId, msg, clientConnections);
        break;
      case 'write':
        this.handleWrite(ws, userId, msg, clientConnections);
        break;
      case 'close':
        this.handleClose(ws, userId, msg, clientConnections);
        break;
      default:
        ws.send(JSON.stringify({ t: 'error', id: msg.id, msg: 'Unknown message type' }));
    }
  }

  async handleOpen(ws, userId, msg, clientConnections) {
    const { id, host, port } = msg;

    // SECURITY: Validate port
    if (!this.config.allowedPorts.includes(port)) {
      this.logger.info(userId, 'BLOCKED_PORT', { host, port });
      ws.send(JSON.stringify({ t: 'error', id, msg: `Port ${port} not allowed` }));
      return;
    }

    // SECURITY: Rate limit check
    const rateCheck = this.rateLimiter.canConnect(userId);
    if (!rateCheck.allowed) {
      this.logger.info(userId, 'RATE_LIMITED', { host, port, reason: rateCheck.reason });
      ws.send(JSON.stringify({ t: 'error', id, msg: rateCheck.reason }));
      return;
    }

    // SECURITY: DNS resolution with validation
    let resolved;
    try {
      resolved = await this.dnsResolver.resolveAndValidate(host);
    } catch (err) {
      this.logger.info(userId, 'DNS_BLOCKED', { host, port, error: err.message });
      ws.send(JSON.stringify({ t: 'error', id, msg: err.message }));
      return;
    }

    // Create TCP connection (use TLS for port 443)
    const useTLS = port === 443;
    let socket;

    if (useTLS) {
      socket = tls.connect({
        host: resolved.ip,
        port: port,
        servername: host,  // SNI
        rejectUnauthorized: true,
      });
    } else {
      socket = new net.Socket();
      socket.connect(port, resolved.ip);
    }

    const timeout = setTimeout(() => {
      socket.destroy();
      this.logger.info(userId, 'CONNECT_TIMEOUT', { host, port });
      ws.send(JSON.stringify({ t: 'error', id, msg: 'Connection timeout' }));
    }, this.config.rateLimits.connectionTimeout);

    const onConnect = () => {
      clearTimeout(timeout);

      this.rateLimiter.recordConnection(userId);
      clientConnections.set(id, {
        socket,
        host,
        port,
        ip: resolved.ip,
        useTLS,
      });

      this.logger.info(userId, 'CONNECTED', { host, port, ip: resolved.ip, tls: useTLS });
      ws.send(JSON.stringify({ t: 'opened', id }));

      // Set idle timeout
      socket.setTimeout(this.config.rateLimits.idleTimeout, () => {
        this.logger.info(userId, 'IDLE_TIMEOUT', { host, port });
        socket.destroy();
      });
    };

    if (useTLS) {
      socket.on('secureConnect', onConnect);
    } else {
      socket.on('connect', onConnect);
    }

    socket.on('data', (data) => {
      // SECURITY: Bandwidth limit check
      const bwCheck = this.rateLimiter.canTransfer(userId, data.length);
      if (!bwCheck.allowed) {
        this.logger.info(userId, 'BANDWIDTH_EXCEEDED', { host, port });
        socket.destroy();
        return;
      }

      this.rateLimiter.recordBytes(userId, data.length);

      const b64 = data.toString('base64');
      ws.send(JSON.stringify({ t: 'data', id, b64 }));
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      if (clientConnections.has(id)) {
        clientConnections.delete(id);
        this.rateLimiter.recordDisconnection(userId);
        ws.send(JSON.stringify({ t: 'closed', id }));
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      this.logger.error(userId, 'SOCKET_ERROR', err);
      if (clientConnections.has(id)) {
        clientConnections.delete(id);
        this.rateLimiter.recordDisconnection(userId);
      }
      ws.send(JSON.stringify({ t: 'error', id, msg: err.message }));
    });
  }

  handleWrite(ws, userId, msg, clientConnections) {
    const { id, b64 } = msg;
    const conn = clientConnections.get(id);

    if (!conn) {
      ws.send(JSON.stringify({ t: 'error', id, msg: 'Connection not found' }));
      return;
    }

    const data = Buffer.from(b64, 'base64');

    // SECURITY: Bandwidth limit check
    const bwCheck = this.rateLimiter.canTransfer(userId, data.length);
    if (!bwCheck.allowed) {
      this.logger.info(userId, 'BANDWIDTH_EXCEEDED', { id });
      ws.send(JSON.stringify({ t: 'error', id, msg: bwCheck.reason }));
      return;
    }

    this.rateLimiter.recordBytes(userId, data.length);
    conn.socket.write(data);
  }

  handleClose(ws, userId, msg, clientConnections) {
    const { id } = msg;
    const conn = clientConnections.get(id);

    if (conn) {
      conn.socket.end();
      clientConnections.delete(id);
      this.rateLimiter.recordDisconnection(userId);
      this.logger.info(userId, 'CLOSED', { host: conn.host, port: conn.port });
      ws.send(JSON.stringify({ t: 'closed', id }));
    }
  }
}

// =============================================================================
// Entry Point
// =============================================================================

if (CONFIG.auth.enabled && CONFIG.auth.jwtSecret === 'dev-secret-change-in-production') {
  console.warn('\n!!! WARNING !!!\n');
  console.warn('Using default JWT secret. This is insecure for production.');
  console.warn('Set JWT_SECRET environment variable to a secure random value.\n');
}

const server = new WSProxyServer(CONFIG);
server.start();
