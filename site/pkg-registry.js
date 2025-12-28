/**
 * Package Registry for lwpkg
 *
 * Defines available packages that can be downloaded on-demand.
 * Large packages are hosted on Cloudflare R2 CDN.
 */

const PACKAGE_REGISTRY = {
  nodejs: {
    name: 'nodejs',
    version: '20.10.0',
    description: 'Node.js JavaScript runtime',
    // TODO: Update with actual R2 bucket URL after setup
    url: 'https://pub-XXXXXXXX.r2.dev/nodejs-20.10.0.wasm',
    size: 52428800,  // ~50MB estimated
    sha256: null,    // TODO: Add hash after building
    binName: 'node',
    large: true,     // Requires browser-side download with progress
  },

  // Future packages can be added here:
  // python: {
  //   name: 'python',
  //   version: '3.12.0',
  //   url: 'https://pub-XXXXXXXX.r2.dev/python-3.12.0.wasm',
  //   size: 30000000,
  //   binName: 'python3',
  //   large: true,
  // },
};

/**
 * Get package info by name
 * @param {string} pkgName - Package name
 * @returns {Object|null} Package info or null if not found
 */
function getPackageInfo(pkgName) {
  return PACKAGE_REGISTRY[pkgName] || null;
}

/**
 * List all available packages
 * @returns {Array} Array of package names
 */
function listPackages() {
  return Object.keys(PACKAGE_REGISTRY);
}

/**
 * Check if a package requires large download (browser-side fetch)
 * @param {string} pkgName - Package name
 * @returns {boolean} True if package is large
 */
function isLargePackage(pkgName) {
  const pkg = PACKAGE_REGISTRY[pkgName];
  return pkg ? pkg.large === true : false;
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.PACKAGE_REGISTRY = PACKAGE_REGISTRY;
  window.getPackageInfo = getPackageInfo;
  window.listPackages = listPackages;
  window.isLargePackage = isLargePackage;
}
