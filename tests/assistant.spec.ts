import { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@grafana/plugin-e2e';

// Needs the dev stack with the scripted LLM mock:  docker compose --profile e2e up -d
// The tests point Grafana's LLM app at the mock and restore its settings afterwards. Stored API keys are left alone:
// a dummy key is only saved where none is configured, and removed again afterwards.
const MOCK = 'http://localhost:3099';
const SETTINGS = '/api/plugins/grafana-llm-app/settings';
const CLARITY = '/a/ipv4addr-clarity-app';
const DUMMY_KEY = 'dummy-e2e';
// provider types of the LLM app; Ollama and OpenRouter are set up as OpenAI-compatible ("custom") APIs
const PROVIDERS = {
  openai: { type: 'openai', key: 'openAIKey' },
  anthropic: { type: 'anthropic', key: 'anthropicKey' },
  ollama: { type: 'custom', key: 'openAIKey' },
  openrouter: { type: 'custom', key: 'openAIKey' },
};
type Provider = keyof typeof PROVIDERS;
const KEYS = ['openAIKey', 'anthropicKey'];

test.describe.configure({ mode: 'serial' }); // the tests switch the LLM app's settings

let original: { jsonData: object; secureJsonFields: Record<string, boolean> };

const saveSettings = async (request: APIRequestContext, data: object) => {
  // the LLM app only picks up a change saved in a later second than the one before (settings are versioned by
  // their update time in seconds)
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const res = await request.post(SETTINGS, { data: { enabled: true, pinned: true, ...data } });
  expect(res.ok()).toBeTruthy();
};

test.beforeAll(async ({ request }) => {
  original = await (await request.get(SETTINGS)).json();
});
test.afterAll(async ({ request }) => {
  // an empty secure value counts as not configured; keys that were set before the run are not touched
  const testKeys = KEYS.filter((k) => !original.secureJsonFields[k]);
  await saveSettings(request, {
    jsonData: original.jsonData,
    secureJsonData: Object.fromEntries(testKeys.map((k) => [k, ''])),
  });
});

/** Whether a run through this provider sends no key: Ollama needs none, unless the admin had set one. */
const keyless = (provider: Provider) => provider === 'ollama' && !original.secureJsonFields.openAIKey;

/** Points the LLM app at the mock; the provider name in the URL's path tells the requests apart. */
const useProvider = async (request: APIRequestContext, provider: Provider, extra: object = {}) => {
  const { type, key } = PROVIDERS[provider];
  const api = { url: `http://mock-llm:8080/${provider}` };
  await saveSettings(request, {
    jsonData: {
      provider: type,
      ...(type === 'anthropic' ? { anthropic: api } : { openAI: api }),
      models: { default: 'base', mapping: { base: 'mock-base', large: 'mock-model' } },
      ...extra,
    },
    secureJsonData: original.secureJsonFields[key] ? undefined : { [key]: keyless(provider) ? '' : DUMMY_KEY },
  });
};

const requests = async (request: APIRequestContext) => (await (await request.get(`${MOCK}/requests`)).json()) as any[];

const ask = async (page: Page, question: string) => {
  await page.goto(CLARITY); // the LLM app is checked at page load
  await page.getByRole('textbox', { name: 'Question' }).fill(question);
  await page.keyboard.press('Enter');
};

const investigation = (page: Page) => page.locator('.markdown-html', { hasText: 'Mock investigation done.' });

for (const provider of Object.keys(PROVIDERS) as Provider[]) {
  test(`${provider}: runs every tool against real data and renders the results`, async ({ page, request }) => {
    await useProvider(request, provider);
    const before = (await requests(request)).length;
    const browserUrls: string[] = [];
    page.on('request', (r) => browserUrls.push(r.url()));

    await ask(page, 'What is going on?');
    const answer = investigation(page);
    await expect(answer).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('alert')).toHaveCount(0); // no tool failed
    // the mock echoes the first line of every tool result
    await expect(answer).toContainText('Values of service_name:');
    await expect(answer).toContainText(/\d+ spans\. Root:/);
    await expect(page.getByRole('link', { name: 'Explore' }).first()).toBeVisible();
    // alert rules from Prometheus' own ruler show up next to the Grafana-managed ones
    await expect(page.getByRole('gridcell', { name: 'HotRODRedisErrors' })).toBeVisible();
    // the streamed reasoning shows as a progress note
    await expect(page.getByText('Checking alerts, metrics, logs and traces.', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/^mock-model · 3 model calls · 3\.0k tokens in \(1\.2k cached\) · 300 out$/)
    ).toBeVisible();

    // the LLM app's health check asks without streaming; the chat streams
    const sent = (await requests(request)).slice(before).filter((r) => r.body.stream);
    expect(sent).toHaveLength(3); // tools, get_trace, answer
    for (const r of sent) {
      expect(r.url).toBe(`/${provider}/v1/chat/completions`);
      expect(r.body.model).toBe('mock-model'); // "large", mapped by the LLM app
      expect(r.headers['user-agent']).not.toMatch(/Mozilla/); // sent by Grafana, not the browser
      // the key is added by the LLM app; Clarity has none
      const credential: string = r.headers.authorization ?? '';
      if (keyless(provider)) {
        expect(credential).toMatch(/^(Bearer)?\s*$/);
      } else if (original.secureJsonFields[PROVIDERS[provider].key]) {
        expect(credential).toMatch(/^Bearer \S{4,}/);
      } else {
        expect(credential).toBe(`Bearer ${DUMMY_KEY}`.slice(0, 12) + '…');
      }
    }
    expect(browserUrls.filter((u) => u.startsWith(MOCK) || u.includes('mock-llm'))).toEqual([]);
    expect(sent[2].body.messages.map((m: any) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      ...Array(8).fill('tool'),
      'assistant',
      ...Array(3).fill('tool'), // the mock opens the three slowest traces
    ]);
    // the arguments were streamed in pieces
    expect(JSON.parse(sent[2].body.messages[2].tool_calls[2].function.arguments)).toMatchObject({ expr: 'up' });
  });
}

test('Ask Clarity in a panel menu opens the page and asks about that panel, once', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
  page,
  request,
}) => {
  await useProvider(request, 'openai');
  const dashboard = await readProvisionedDashboard({ fileName: 'hotrod.json' });
  const dashboardPage = await gotoDashboardPage(dashboard);
  await dashboardPage
    .getPanelByTitle('Requests per service')
    .clickOnMenuItem('Ask Clarity', { parentItem: 'Extensions' });
  await expect(page.getByRole('heading', { name: 'Clarity' })).toBeVisible();
  await expect(page.getByText('Explain the panel "Requests per service"', { exact: true })).toBeVisible(); // the label
  await expect(investigation(page)).toBeVisible({ timeout: 90_000 });
  // the model gets the full question with the panel's queries
  const question = (await requests(request)).at(-1).body.messages.find((m: any) => m.role === 'user').content;
  expect(question).toContain(`Explain what the panel "Requests per service" on dashboard ${dashboard.uid}`);
  expect(question).toContain('Its queries:');
  await page.reload(); // the question is not asked again
  await expect(page.getByText('What should we look into?')).toBeVisible();
});

test('does not let an answer load remote content by itself', async ({ page, request }) => {
  await useProvider(request, 'openai');
  await ask(page, 'markdown test');
  const answer = page.locator('.markdown-html', { hasText: 'Injected:' });
  await expect(answer).toBeVisible();
  await expect(answer.locator('img, [style], [class]')).toHaveCount(0);
  await expect(answer.getByRole('checkbox')).toHaveCount(2); // task lists survive
  await expect(answer).toContainText('http://HOST:PORT/metrics'); // unparsable URL does not crash the chat
  await expect(answer).toContainText('https://evil.example/leak.png?d=secret'); // shown as text instead
  await expect(answer.getByRole('link', { name: 'docs' })).toHaveAttribute('target', '_blank');
});

test('Continue picks up after Stop', async ({ page, request }) => {
  await useProvider(request, 'openai');
  await ask(page, 'slow start: what is going on?');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Stopped.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(investigation(page)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  const users = (await requests(request)).at(-1).body.messages.filter((m: any) => m.role === 'user');
  expect(users.map((m: any) => m.content)).toEqual([
    expect.stringContaining('slow start: what is going on?'),
    expect.stringContaining('The previous attempt was interrupted'),
  ]);
});

test('Continue picks up after an API error mid-answer', async ({ page, request }) => {
  await useProvider(request, 'openrouter');
  await ask(page, 'flaky: what is going on?');
  await expect(page.getByRole('alert')).toContainText('Provider returned error');
  // the half-written answer is marked as interrupted
  await expect(page.locator('.markdown-html', { hasText: 'Looking at the alerts first' })).toHaveCSS('opacity', '0.6');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(investigation(page)).toBeVisible({ timeout: 90_000 });
});

test('a provider error shows in the chat', async ({ page, request }) => {
  await useProvider(request, 'openai', {
    models: { default: 'base', mapping: { base: 'mock-base', large: 'bad-model' } },
  });
  await ask(page, 'What is going on?');
  await expect(page.getByRole('alert')).toHaveText(
    'Model not found (404): bad-model is not a valid model ID. Check the models set in the Grafana LLM app.'
  );
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible(); // the run ended
});

test('a refusal ends the run without Continue', async ({ page, request }) => {
  await useProvider(request, 'openai');
  await ask(page, 'refuse: what is going on?');
  await expect(page.getByRole('alert')).toHaveText('I cannot help with that.');
  await expect(page.getByText('Working…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
});

test('without a working LLM app the chat says what is missing', async ({ page, request }) => {
  await useProvider(request, 'openai', { disabled: true }); // the LLM app's own switch; it cannot be disabled itself
  await page.goto(CLARITY);
  const notice = page.getByRole('status', { name: 'Clarity needs the Grafana LLM app' });
  await expect(notice).toContainText('LLM functionality is disabled');
  await expect(page.getByRole('textbox', { name: 'Question' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'What alerts are firing and why?' })).toBeDisabled();
  await notice.getByRole('link', { name: 'LLM app page' }).click();
  await expect(page).toHaveURL(/\/plugins\/grafana-llm-app/);
});

test('a ?q= link asks the question; follow-ups and Copy as Markdown work', async ({ page, request }) => {
  await useProvider(request, 'openai');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${CLARITY}?q=What%20is%20going%20on%3F`);
  await expect(page.getByText('What is going on?', { exact: true })).toBeVisible(); // asked right away
  await expect(page).not.toHaveURL(/[?&]q=/); // a reload does not ask it again

  const answer = investigation(page);
  await expect(answer).toBeVisible({ timeout: 90_000 });
  await expect(answer).not.toContainText('Follow-ups'); // shown as buttons instead
  await page.getByRole('button', { name: 'Copy as Markdown' }).click();
  const md = await page.evaluate(() => navigator.clipboard.readText());
  expect(md).toContain('## What is going on?');
  expect(md).toMatch(/- PromQL · Prometheus: `.+` \(\[Explore\]\(http:\/\/localhost:3000\/explore\?/);
  expect(md).toContain('**Mock investigation done.**');

  await page.getByRole('button', { name: 'Is payments running?' }).click();
  await expect(page.getByText('Is payments running?', { exact: true }).first()).toBeVisible(); // asked as the next question
});
