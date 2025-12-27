// fs-persist.js - IndexedDB-backed filesystem persistence
// SPDX-License-Identifier: MIT

'use strict';

/**
 * FilesystemPersist - IndexedDB wrapper for persistent filesystem storage
 *
 * Provides persistent storage for /home, /root, and /opt directories.
 * Files are stored as blobs with their full paths as keys.
 *
 * Usage:
 *   const fsPersist = new FilesystemPersist();
 *   await fsPersist.init();
 *
 *   await fsPersist.saveFile('/home/user/.bashrc', content);
 *   const content = await fsPersist.loadFile('/home/user/.bashrc');
 *   const files = await fsPersist.listFiles('/home/');
 */
class FilesystemPersist {
  constructor(dbName = 'linux-wasm-fs') {
    this.dbName = dbName;
    this.db = null;
    this.STORE_NAME = 'files';
    this.META_STORE = 'metadata';
  }

  /**
   * Initialize the IndexedDB database
   * @returns {Promise<void>}
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 2);

      request.onerror = () => {
        reject(new Error('Failed to open IndexedDB: ' + request.error));
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[FsPersist] Database initialized');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create files store if it doesn't exist
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'path' });
          store.createIndex('directory', 'directory', { unique: false });
          store.createIndex('mtime', 'mtime', { unique: false });
        }

        // Create metadata store for filesystem stats
        if (!db.objectStoreNames.contains(this.META_STORE)) {
          db.createObjectStore(this.META_STORE, { keyPath: 'key' });
        }
      };
    });
  }

  /**
   * Save a file to persistent storage
   * @param {string} path - Full path (e.g., '/home/user/.bashrc')
   * @param {Uint8Array|string} content - File content
   * @param {object} metadata - Optional metadata (mode, uid, gid)
   * @returns {Promise<void>}
   */
  async saveFile(path, content, metadata = {}) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);

      // Convert string to Uint8Array if needed
      if (typeof content === 'string') {
        content = new TextEncoder().encode(content);
      }

      // Extract directory from path
      const lastSlash = path.lastIndexOf('/');
      const directory = lastSlash > 0 ? path.substring(0, lastSlash) : '/';

      const record = {
        path: path,
        directory: directory,
        content: content,
        size: content.length,
        mtime: Date.now(),
        mode: metadata.mode || 0o644,
        uid: metadata.uid || 0,
        gid: metadata.gid || 0,
      };

      const request = store.put(record);

      request.onerror = () => reject(new Error('Failed to save file: ' + request.error));
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Load a file from persistent storage
   * @param {string} path - Full path to the file
   * @returns {Promise<{content: Uint8Array, metadata: object}|null>}
   */
  async loadFile(path) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.get(path);

      request.onerror = () => reject(new Error('Failed to load file: ' + request.error));
      request.onsuccess = () => {
        if (request.result) {
          resolve({
            content: request.result.content,
            metadata: {
              size: request.result.size,
              mtime: request.result.mtime,
              mode: request.result.mode,
              uid: request.result.uid,
              gid: request.result.gid,
            }
          });
        } else {
          resolve(null);
        }
      };
    });
  }

  /**
   * Delete a file from persistent storage
   * @param {string} path - Full path to the file
   * @returns {Promise<void>}
   */
  async deleteFile(path) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.delete(path);

      request.onerror = () => reject(new Error('Failed to delete file: ' + request.error));
      request.onsuccess = () => resolve();
    });
  }

  /**
   * List all files under a directory prefix
   * @param {string} prefix - Directory prefix (e.g., '/home/')
   * @returns {Promise<Array<{path: string, size: number, mtime: number}>>}
   */
  async listFiles(prefix = '/') {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.openCursor();
      const files = [];

      request.onerror = () => reject(new Error('Failed to list files: ' + request.error));
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          if (cursor.value.path.startsWith(prefix)) {
            files.push({
              path: cursor.value.path,
              size: cursor.value.size,
              mtime: cursor.value.mtime,
              mode: cursor.value.mode,
            });
          }
          cursor.continue();
        } else {
          resolve(files);
        }
      };
    });
  }

  /**
   * List files in a specific directory (non-recursive)
   * @param {string} directory - Directory path (e.g., '/home/user')
   * @returns {Promise<Array<{path: string, size: number, mtime: number}>>}
   */
  async listDirectory(directory) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const index = store.index('directory');
      const request = index.getAll(directory);

      request.onerror = () => reject(new Error('Failed to list directory: ' + request.error));
      request.onsuccess = () => {
        resolve(request.result.map(r => ({
          path: r.path,
          size: r.size,
          mtime: r.mtime,
          mode: r.mode,
        })));
      };
    });
  }

  /**
   * Check if a file exists
   * @param {string} path - Full path to the file
   * @returns {Promise<boolean>}
   */
  async exists(path) {
    const file = await this.loadFile(path);
    return file !== null;
  }

  /**
   * Get total storage used
   * @returns {Promise<number>} - Total bytes used
   */
  async getStorageUsed() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.openCursor();
      let totalSize = 0;

      request.onerror = () => reject(new Error('Failed to calculate storage: ' + request.error));
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          totalSize += cursor.value.size;
          cursor.continue();
        } else {
          resolve(totalSize);
        }
      };
    });
  }

  /**
   * Clear all stored files
   * @returns {Promise<void>}
   */
  async clear() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.clear();

      request.onerror = () => reject(new Error('Failed to clear storage: ' + request.error));
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Export all files as a JSON object (for backup)
   * @returns {Promise<object>}
   */
  async exportAll() {
    const files = await this.listFiles('/');
    const result = {};

    for (const file of files) {
      const data = await this.loadFile(file.path);
      if (data) {
        // Convert Uint8Array to base64 for JSON serialization
        result[file.path] = {
          content: this.uint8ArrayToBase64(data.content),
          metadata: data.metadata,
        };
      }
    }

    return result;
  }

  /**
   * Import files from a JSON backup
   * @param {object} backup - Backup object from exportAll()
   * @returns {Promise<number>} - Number of files imported
   */
  async importAll(backup) {
    let count = 0;

    for (const [path, data] of Object.entries(backup)) {
      const content = this.base64ToUint8Array(data.content);
      await this.saveFile(path, content, data.metadata);
      count++;
    }

    return count;
  }

  /**
   * Save metadata value
   * @param {string} key - Metadata key
   * @param {any} value - Value to store
   * @returns {Promise<void>}
   */
  async setMetadata(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.META_STORE], 'readwrite');
      const store = tx.objectStore(this.META_STORE);
      const request = store.put({ key, value, updated: Date.now() });

      request.onerror = () => reject(new Error('Failed to set metadata: ' + request.error));
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Get metadata value
   * @param {string} key - Metadata key
   * @returns {Promise<any>}
   */
  async getMetadata(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.META_STORE], 'readonly');
      const store = tx.objectStore(this.META_STORE);
      const request = store.get(key);

      request.onerror = () => reject(new Error('Failed to get metadata: ' + request.error));
      request.onsuccess = () => {
        resolve(request.result ? request.result.value : null);
      };
    });
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
  module.exports = FilesystemPersist;
}
