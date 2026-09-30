import { lazy } from 'react';
import { AppPlugin, PluginExtensionPanelContext, PluginExtensionPoints } from '@grafana/data';
import { locationService } from '@grafana/runtime';
import pluginJson from './plugin.json';

// Keep this module tiny: the panel-menu link makes Grafana load it on every page, so the chat UI is lazy-loaded.

const App = lazy(() => import('./components/App'));

/** The question the panel-menu link asks: the panel's title, dashboard, time range and raw queries. */
const panelPrompt = (ctx?: PluginExtensionPanelContext): string => {
  const queries = (ctx?.targets ?? []).map((t) => JSON.stringify(t)).join('\n');
  return (
    `Explain what the panel "${ctx?.title ?? ''}" on dashboard ${ctx?.dashboard?.uid ?? '?'} shows ` +
    `(time range ${ctx?.timeRange.from} to ${ctx?.timeRange.to}) and whether anything looks wrong. ` +
    `Its queries:\n${queries}`
  );
};

export const plugin = new AppPlugin<{}>().setRootPage(App).addLink<PluginExtensionPanelContext>({
  targets: [PluginExtensionPoints.DashboardPanelMenu],
  title: 'Ask Clarity', // must equal the title in plugin.json "extensions"
  description: 'Explain this panel and check it for problems',
  icon: 'ai-sparkle',
  // Opens the Clarity page, which asks the question (see App). It travels in the history state rather than as
  // ?q=: the panel's queries make it long, and it is shown under a short label.
  onClick: (_e, { context }) =>
    locationService.push({
      pathname: `/a/${pluginJson.id}`,
      state: { prompt: panelPrompt(context), label: `Explain the panel "${context?.title ?? ''}"` },
    }),
});
