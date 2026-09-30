import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { PluginPage, locationService } from '@grafana/runtime';
import { Button, ClipboardButton, useStyles2 } from '@grafana/ui';
import pluginJson from '../plugin.json';
import { chat, transcript, useChat } from '../agent/store';
import { Chat, ChatProps } from './Chat';
import { Logo } from './Logo';

/** The Clarity page: the conversation with its header and input. */
const App = () => {
  const s = useStyles2(getStyles);
  const { items, busy } = useChat();
  // A question to ask right away, once: from the panel menu (history state, see module.tsx) or a /a/<id>?q=...
  // link (e.g. "Investigate" in an alert notification).
  const [link] = useState((): ChatProps => {
    const panel = locationService.getLocation().state as Pick<ChatProps, 'prompt' | 'label'> | undefined;
    const prompt = panel?.prompt ?? locationService.getSearch().get('q')?.trim().slice(0, 1000);
    return prompt ? { prompt, label: panel?.label, nonce: Date.now() } : {};
  });
  useEffect(() => {
    if (link.prompt) {
      locationService.replace(`/a/${pluginJson.id}`); // drops ?q= and the state: a reload must not ask it again
    }
  }, [link]);
  // Custom layout and out of flow: Grafana's page containers grow with their content, so the chat gets a
  // fixed height (and its own scroller) only when it does not take part in their sizing
  return (
    <PluginPage layout={PageLayoutType.Custom}>
      <div className={s.page}>
        <div className={s.header}>
          <h2 className={s.title}>
            <Logo size={32} busy={busy} />
            Clarity
          </h2>
          <ClipboardButton icon="copy" variant="secondary" getText={() => transcript(items)} disabled={!items.length}>
            Copy as Markdown
          </ClipboardButton>
          <Button icon="plus" variant="secondary" onClick={chat.reset}>
            New conversation
          </Button>
        </div>
        <Chat {...link} />
      </div>
    </PluginPage>
  );
};

export default App;

const getStyles = (theme: GrafanaTheme2) => ({
  page: css({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    maxWidth: 1100,
    margin: '0 auto',
    paddingTop: theme.spacing(2),
  }),
  header: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(2), padding: theme.spacing(0, 2) }),
  title: css({ flex: 1, display: 'flex', alignItems: 'center', gap: theme.spacing(1.5), margin: 0 }),
});
