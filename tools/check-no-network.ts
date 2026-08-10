import type { Page } from '@playwright/test';

const LOCAL_HOSTS = new Set(['[::1]', '::1', 'localhost', '127.0.0.1']);
const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

export function isAllowedHarnessUrl(value: string): boolean {
  const url = new URL(value);
  return !NETWORK_PROTOCOLS.has(url.protocol) || LOCAL_HOSTS.has(url.hostname);
}

export async function installNoNetworkGuard(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.route(/.*/, async (route) => {
    const url = route.request().url();
    if (!isAllowedHarnessUrl(url)) {
      violations.push(url);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  return violations;
}
