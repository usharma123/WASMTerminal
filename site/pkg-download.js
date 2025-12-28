/**
 * Package Download Manager
 *
 * Handles downloading large Wasm binaries with progress reporting.
 * Uses browser fetch() API with streaming for progress updates.
 * Stores downloaded packages in IndexedDB via fs-persist.js.
 */

class PackageDownloader {
  /**
   * @param {FilesystemPersist} fsPersist - IndexedDB persistence layer
   * @param {Function} progressCallback - Called with {loaded, total, percent}
   */
  constructor(fsPersist, progressCallback = null) {
    this.fsPersist = fsPersist;
    this.onProgress = progressCallback;
  }

  /**
   * Download a file with progress reporting
   * @param {string} url - URL to download from
   * @param {number} expectedSize - Expected file size (for progress if Content-Length missing)
   * @returns {Promise<Uint8Array>} Downloaded binary data
   */
  async downloadWithProgress(url, expectedSize = 0) {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/wasm, application/octet-stream' }
    });

    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
    }

    const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
    const total = contentLength || expectedSize;

    if (!response.body) {
      // Fallback for browsers without streaming support
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      chunks.push(value);
      loaded += value.length;

      // Report progress
      if (this.onProgress && total > 0) {
        this.onProgress({
          loaded,
          total,
          percent: Math.min(100, Math.floor((loaded / total) * 100))
        });
      }
    }

    // Combine chunks into single Uint8Array
    const result = new Uint8Array(loaded);
    let position = 0;
    for (const chunk of chunks) {
      result.set(chunk, position);
      position += chunk.length;
    }

    return result;
  }

  /**
   * Verify binary integrity using SHA-256
   * @param {Uint8Array} data - Binary data to verify
   * @param {string} expectedHash - Expected SHA-256 hash (hex)
   * @returns {Promise<boolean>} True if hash matches
   */
  async verifyIntegrity(data, expectedHash) {
    if (!expectedHash) return true;  // Skip if no hash provided

    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return hashHex === expectedHash.toLowerCase();
  }

  /**
   * Check if a package is already cached in IndexedDB
   * @param {string} pkgName - Package name
   * @returns {Promise<boolean>} True if cached
   */
  async isPackageCached(pkgName) {
    if (!this.fsPersist) return false;
    return await this.fsPersist.exists(`/opt/pkg/${pkgName}.wasm`);
  }

  /**
   * Get cached package metadata
   * @param {string} pkgName - Package name
   * @returns {Promise<Object|null>} Package metadata or null
   */
  async getPackageMetadata(pkgName) {
    if (!this.fsPersist) return null;
    return await this.fsPersist.getMetadata(`pkg:${pkgName}`);
  }

  /**
   * Install a package (download and cache)
   * @param {string} pkgName - Package name from registry
   * @returns {Promise<{cached: boolean, size?: number}>} Install result
   */
  async install(pkgName) {
    const packageInfo = getPackageInfo(pkgName);
    if (!packageInfo) {
      throw new Error(`Unknown package: ${pkgName}`);
    }

    // Check if already cached
    if (await this.isPackageCached(pkgName)) {
      return { cached: true };
    }

    // Download binary
    const binary = await this.downloadWithProgress(packageInfo.url, packageInfo.size);

    // Verify integrity if hash provided
    if (packageInfo.sha256) {
      const valid = await this.verifyIntegrity(binary, packageInfo.sha256);
      if (!valid) {
        throw new Error(`Integrity check failed for ${pkgName}`);
      }
    }

    // Save to IndexedDB
    await this.fsPersist.saveFile(`/opt/pkg/${pkgName}.wasm`, binary, {
      mode: 0o755,
    });

    // Save metadata
    await this.fsPersist.setMetadata(`pkg:${pkgName}`, {
      version: packageInfo.version,
      installedAt: Date.now(),
      binName: packageInfo.binName,
      size: binary.length,
    });

    return { cached: false, size: binary.length };
  }

  /**
   * Load a cached package binary
   * @param {string} pkgName - Package name
   * @returns {Promise<Uint8Array|null>} Binary data or null if not cached
   */
  async loadPackage(pkgName) {
    if (!this.fsPersist) return null;

    const file = await this.fsPersist.loadFile(`/opt/pkg/${pkgName}.wasm`);
    return file ? file.content : null;
  }

  /**
   * Remove a cached package
   * @param {string} pkgName - Package name
   * @returns {Promise<boolean>} True if removed
   */
  async removePackage(pkgName) {
    if (!this.fsPersist) return false;

    await this.fsPersist.deleteFile(`/opt/pkg/${pkgName}.wasm`);
    await this.fsPersist.setMetadata(`pkg:${pkgName}`, null);
    return true;
  }

  /**
   * List all cached packages
   * @returns {Promise<Array<{name: string, binName: string, size: number}>>}
   */
  async listCachedPackages() {
    if (!this.fsPersist) return [];

    const files = await this.fsPersist.listFiles('/opt/pkg/');
    const packages = [];

    for (const file of files) {
      if (file.path.endsWith('.wasm')) {
        const pkgName = file.path.replace('/opt/pkg/', '').replace('.wasm', '');
        const meta = await this.fsPersist.getMetadata(`pkg:${pkgName}`);
        if (meta) {
          packages.push({
            name: pkgName,
            binName: meta.binName,
            size: meta.size || file.size,
            version: meta.version,
          });
        }
      }
    }

    return packages;
  }
}

/**
 * Terminal Progress Bar
 * Renders a progress bar in xterm.js terminal
 */
class TerminalProgressBar {
  /**
   * @param {Terminal} term - xterm.js Terminal instance
   * @param {number} width - Progress bar width in characters
   */
  constructor(term, width = 40) {
    this.term = term;
    this.width = width;
    this.active = false;
  }

  /**
   * Update progress bar
   * @param {string} label - Label to show (e.g., "Downloading nodejs")
   * @param {number} percent - Progress percentage (0-100)
   * @param {number} loaded - Bytes loaded
   * @param {number} total - Total bytes
   */
  update(label, percent, loaded, total) {
    if (!this.active) {
      this.active = true;
    }

    // Clear current line
    this.term.write('\r\x1b[K');

    // Calculate filled/empty portions
    const filled = Math.floor((percent / 100) * this.width);
    const empty = this.width - filled;

    // Build progress bar
    const bar = '[' + '='.repeat(filled) + (filled < this.width ? '>' : '') + ' '.repeat(Math.max(0, empty - 1)) + ']';

    // Format sizes
    const loadedMB = (loaded / 1024 / 1024).toFixed(1);
    const totalMB = (total / 1024 / 1024).toFixed(1);

    // Write progress line
    const line = `${label}: ${bar} ${percent}% (${loadedMB}/${totalMB} MB)`;
    this.term.write(line);
  }

  /**
   * Complete progress and show final message
   * @param {string} message - Completion message
   */
  complete(message) {
    if (this.active) {
      this.term.write('\r\x1b[K');  // Clear line
      this.active = false;
    }
    this.term.write(message + '\r\n');
  }

  /**
   * Show error message
   * @param {string} message - Error message
   */
  error(message) {
    if (this.active) {
      this.term.write('\r\x1b[K');
      this.active = false;
    }
    this.term.write('\x1b[31m' + message + '\x1b[0m\r\n');  // Red text
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.PackageDownloader = PackageDownloader;
  window.TerminalProgressBar = TerminalProgressBar;
}
