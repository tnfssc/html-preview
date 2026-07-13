import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ mode }) => ({
    name:
      mode === 'debug'
        ? 'GitHub HTML Preview (Debug)'
        : 'GitHub HTML Preview',
    description:
      'Run and compare commit-pinned public and private HTML directly on GitHub',
    permissions: ['storage'],
    host_permissions: [
      '*://github.com/*',
      '*://raw.githubusercontent.com/*',
      '*://cdn.jsdelivr.net/*',
      '*://api.github.com/*',
    ],
    web_accessible_resources: [
      {
        resources: ['preview.html', 'sandbox.html'],
        matches: ['*://github.com/*'],
        use_dynamic_url: true,
      },
    ],
    sandbox: {
      pages: ['sandbox.html'],
    },
    content_security_policy: {
      extension_pages: [
        "default-src 'self'",
        "connect-src https://api.github.com https://raw.githubusercontent.com https://cdn.jsdelivr.net",
        "img-src 'self' data:",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
      ].join('; '),
      sandbox: [
        'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
        "default-src 'self' data: blob: https: http:",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:",
        "style-src 'self' 'unsafe-inline' data: blob: https: http:",
        'connect-src data: blob: https: http:',
        'img-src data: blob: https: http:',
        'font-src data: blob: https: http:',
        'media-src data: blob: https: http:',
        'frame-src data: blob: https: http:',
        'worker-src data: blob: https: http:',
      ].join('; '),
    },
    action: {
      default_title: 'GitHub HTML Preview',
    },

  }),
});
