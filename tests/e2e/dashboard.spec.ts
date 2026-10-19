import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const salesChat = readFileSync(path.resolve('examples', 'conversations', 'sales-bot.txt'), 'utf8');

test.describe.configure({ mode: 'serial' });

test('overview lists seeded bots and states the platform limitation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sales Bot' })).toBeVisible();
  await expect(page.getByText(/cannot read, compact or reset Grok Bot/)).toBeVisible();
});

test('import, analyze, review and save a checkpoint', async ({ page }) => {
  await page.goto('/#/analyze/sales');
  await page.getByLabel('Conversation text').fill(salesChat);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText(/30 new message\(s\) imported/)).toBeVisible();

  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByRole('heading', { name: /Needs your confirmation \(1\)/ })).toBeVisible();
  await expect(page.getByText('Never send pricing to Acme without my approval.')).toBeVisible();
  await expect(page.getByText('Never share customer data outside the CRM')).toBeVisible();
  await expect(page.getByText(/sk-proj-/)).toHaveCount(0);

  await page.getByLabel(/I reviewed the retained information/).check();
  await page.getByRole('button', { name: 'Save checkpoint' }).click();
  await expect(page.getByText(/Saved checkpoint v1 \(reviewed\)/)).toBeVisible();
});

test('checkpoint page verifies integrity', async ({ page }) => {
  await page.goto('/#/checkpoints/sales');
  await expect(page.getByRole('link', { name: 'v1' })).toBeVisible();
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText(/Verified\. Checkpoint content hash matches/)).toBeVisible();
});

test('handoff wizard: generate, choose step, report, verify continuation', async ({ page }) => {
  await page.goto('/#/wizard/sales');
  await page.getByRole('button', { name: 'Generate handoff' }).click();
  await expect(page.getByText('HANDOFF_READY').first()).toBeVisible();
  const handoff = await page.locator('pre.handoff').innerText();
  expect(handoff).toContain('# Context handoff: Sales Bot');
  const code = /Checkpoint (GCM-[0-9A-F]{4}-[0-9A-F]{4})/.exec(handoff)?.[1];
  expect(code).toBeTruthy();

  // The destructive option stays disabled until acknowledged.
  const resetChoice = page.locator('.choice-danger').getByRole('button', { name: 'Choose' });
  await expect(resetChoice).toBeDisabled();

  await page.locator('.choice').first().getByRole('button', { name: 'Choose' }).click();
  await expect(page.getByRole('heading', { name: /Step 6/ })).toBeVisible();
  await expect(page.getByText(/Select Sales Bot and at least one other bot/)).toBeVisible();
  await page.getByRole('button', { name: 'I’ve done this' }).click();
  await expect(page.getByText(/cannot be verified by GCM/)).toBeVisible();

  // A reply that ignores the handoff fails recoverably.
  await page.getByLabel('Bot reply').fill('Hi! How can I help you today?');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('FAILED_RECOVERABLE').first()).toBeVisible();

  const tasks = handoff
    .split('## Pending tasks')[1]!
    .split('##')[0]!
    .trim()
    .split('\n')
    .slice(0, 3)
    .join(' ');
  const objective = handoff.split('## Current objective')[1]!.split('##')[0]!.trim();
  await page
    .getByLabel('Bot reply')
    .fill(`Loaded ${code}. Objective: ${objective} Top tasks: ${tasks}`);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('CONTINUATION_VERIFIED').first()).toBeVisible();
});

test('shows API errors instead of failing silently', async ({ page }) => {
  await page.goto('/#/bots/new');
  await page.getByLabel('Bot ID').fill('qa');
  await page.getByLabel('Share read access with').fill('Not A Bot!');
  await page.getByRole('button', { name: 'Save bot' }).click();
  await expect(page.getByRole('alert')).toContainText(/validation/i);
  await expect(page.getByRole('alert')).toContainText(/shareWith/);
});

test('"Add bot" refuses to overwrite an existing bot', async ({ page }) => {
  await page.goto('/#/bots/new');
  await page.getByLabel('Bot ID').fill('sales');
  await page.getByRole('button', { name: 'Save bot' }).click();
  await expect(page.getByRole('alert')).toContainText(/already exists/);
});

test('theme toggle switches to dark mode', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Theme').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('quick-adds bots from a pasted list of names', async ({ page }) => {
  await page.goto('/#/bots');
  await page.getByLabel('Bot names').fill('Support Desk\n5 min ago\nSales\nChief of Staff');
  const preview = page.locator('.quick-preview');
  await expect(preview.getByLabel(/Support Desk/)).toBeChecked();
  await expect(preview).toContainText('Already added: Sales Bot');
  await expect(preview).toContainText('Ignored (not bot names): 5 min ago');
  await preview.getByLabel(/Chief of Staff/).uncheck();
  await page.getByRole('button', { name: 'Add 1 bot', exact: true }).click();
  await expect(page.getByRole('link', { name: /Support Desk/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Chief of Staff/ })).toHaveCount(0);
});

test('"+ New bot" in the bot picker needs only a name', async ({ page }) => {
  await page.goto('/#/analyze');
  await page.getByLabel('Bot', { exact: true }).selectOption({ label: '+ New bot…' });
  await page.getByLabel('New bot name').fill('Ops Team');
  await page.getByRole('button', { name: 'Add bot', exact: true }).click();
  await expect(page).toHaveURL(/#\/analyze\/ops-team$/);
  await expect(page.getByLabel('Conversation text')).toBeVisible();
});

test('layout fits a phone screen @responsive', async ({ page }) => {
  await page.goto('/#/checkpoints/sales');
  await expect(page.getByRole('heading', { name: 'Checkpoints' })).toBeVisible();
  const { overflow, offenders } = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => el.getBoundingClientRect().right > vw + 1 && !el.closest('.table-wrap'))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
    return { overflow: document.documentElement.scrollWidth - vw, offenders };
  });
  expect(overflow, `overflowing elements: ${offenders.join(', ')}`).toBeLessThanOrEqual(1);
});
