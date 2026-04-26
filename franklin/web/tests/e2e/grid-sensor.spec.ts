import { expect, test } from '@playwright/test';

test('home loads and links to grid-sensor', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-footer h1')).toContainText('FRANKLIN');
  await expect(page.locator('a[href="/grid-sensor"]')).toBeVisible();
});

test('/grid-sensor renders zones, devices, and events', async ({ page }) => {
  await page.goto('/grid-sensor');
  await expect(page.locator('.sensor-eyebrow')).toContainText('GRID SENSOR');
  await expect(page.locator('h1')).toContainText('Field telemetry');

  // Wait for the API to fill in cards
  const zoneCards = page.locator('.sensor-card--zone');
  await expect(zoneCards.first()).toBeVisible({ timeout: 8_000 });
  expect(await zoneCards.count()).toBeGreaterThan(0);

  const deviceCards = page.locator('.sensor-card--device');
  await expect(deviceCards.first()).toBeVisible({ timeout: 8_000 });
  expect(await deviceCards.count()).toBeGreaterThan(0);

  // At least one EMERGENCY card if mock failing-device is seeded
  const emergencyCount = await page.locator('.sensor-card--device.sensor-state-EMERGENCY').count();
  console.log(`emergency devices: ${emergencyCount}`);

  // Save a screenshot for the human review
  await page.screenshot({ path: 'test-results/grid-sensor.png', fullPage: true });
});

test('/api/devices returns a non-empty array', async ({ request }) => {
  const r = await request.get('/api/devices');
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(Array.isArray(body)).toBeTruthy();
  expect(body.length).toBeGreaterThan(0);
  for (const d of body) {
    expect(d).toHaveProperty('device');
    expect(d).toHaveProperty('state');
  }
});

test('/api/zones returns DOM zone with resilience score', async ({ request }) => {
  const r = await request.get('/api/zones');
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body).toHaveProperty('DOM');
  expect(body.DOM).toHaveProperty('zone_resilience');
});

test('/api/events returns recent events array', async ({ request }) => {
  const r = await request.get('/api/events?limit=20');
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(Array.isArray(body)).toBeTruthy();
});
