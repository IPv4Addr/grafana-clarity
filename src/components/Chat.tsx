import React, { memo, useEffect, useRef, useState } from 'react';
import { css, cx, keyframes } from '@emotion/css';
import { GrafanaTheme2, IconName } from '@grafana/data';
import { Alert, Button, Icon, useStyles2 } from '@grafana/ui';
import { LLMStatus, LLM_APP, llmStatus } from '../agent/llm';
import { Item, chat, splitFollowUps, useChat } from '../agent/store';
import { safeHtml } from './safeHtml';
import { Step, ToolCard } from './ToolCard';

// the icon names the signal each question starts from
const SUGGESTIONS: Array<[IconName, string]> = [
  ['bell', 'What alerts are firing and why?'],
  ['exclamation-triangle', 'Which services have the highest error rate right now?'],
  ['gf-traces', 'Which traces were slowest in the last hour?'],
  ['heart-rate', 'Is every scrape target up?'],
];

// Motion: new entries rise into place, the welcome and the follow-ups arrive one after the other, "Working…"
// shimmers in the logo's spectrum and a caret blinks while an answer streams. None of it runs for users who
// prefer reduced motion.
const enter = keyframes({ from: { opacity: 0, transform: 'translateY(6px)' } });
const shimmer = keyframes({ from: { backgroundPosition: '100% 0' }, to: { backgroundPosition: '0 0' } });
const blink = keyframes({ '50%': { opacity: 0 } });

// Module scope, not a ref: a remount of the chat must not ask the same question again.
let sentNonce: number | undefined;

export interface ChatProps {
  /** Question to send immediately (once per nonce), e.g. from the panel menu or a ?q= link. */
  prompt?: string;
  /** Short text shown in the chat for `prompt`. */
  label?: string;
  nonce?: number;
}

/** The conversation and its input. */
export const Chat = ({ prompt, label, nonce }: ChatProps) => {
  const s = useStyles2(getStyles);
  const { items, busy, resumable } = useChat();
  const [status, setStatus] = useState<LLMStatus>(); // undefined while the LLM app is being checked
  useEffect(() => {
    llmStatus().then(setStatus);
  }, []);
  const configured = status?.ok !== false;
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow new content unless the user scrolled up to read
  const lastTop = useRef(0); // where we last scrolled to; scrolling above it means the user wants to read

  const ask = (question: string, shown?: string) => {
    stick.current = true;
    chat.send(question, shown);
  };

  useEffect(() => {
    // a panel question that arrives while busy is sent when the current run ends, and only to a working LLM app
    if (prompt && nonce !== sentNonce && !busy && status?.ok) {
      sentNonce = nonce;
      ask(prompt, label);
    }
  });

  useEffect(() => {
    // content also grows after render (panels load, text streams), so watch its size rather than `items`
    const el = scroller.current!;
    const ro = new ResizeObserver(() => {
      if (stick.current) {
        el.scrollTop = el.scrollHeight;
        lastTop.current = el.scrollTop;
      }
    });
    ro.observe(el.firstElementChild!);
    return () => ro.disconnect();
  }, []);

  // follow-up buttons only under the newest answer, once it is complete
  const latestAnswer = busy ? -1 : items.map((i) => i.kind).lastIndexOf('assistant');

  const submit = () => {
    if (draft.trim() && !busy) {
      ask(draft.trim());
      setDraft('');
    }
  };

  return (
    <div className={s.root}>
      <div
        className={s.messages}
        ref={scroller}
        onScroll={(e) => {
          // the event arrives a frame after our own scroll, when content may have grown again: only scrolling
          // above the point we last scrolled to (the user) stops following; back at the bottom resumes it
          const el = e.currentTarget;
          if (el.scrollTop < lastTop.current - 5) {
            stick.current = false;
          } else if (el.scrollHeight - el.scrollTop - el.clientHeight < 50) {
            stick.current = true;
            lastTop.current = el.scrollTop;
          }
        }}
      >
        <div className={s.content}>
          {items.length === 0 && (
            <div className={s.welcome}>
              <h4 className={s.welcomeTitle}>What should we look into?</h4>
              <p className={s.welcomeText}>
                I write and run the PromQL, LogQL and TraceQL with your permissions, and show every query next to the
                answer.
              </p>
              {SUGGESTIONS.map(([icon, q]) => (
                <button key={q} type="button" className={s.suggestion} onClick={() => ask(q)} disabled={!configured}>
                  <Icon name={icon} />
                  {q}
                </button>
              ))}
            </div>
          )}
          {items.map((item, i) => (
            <ChatItem
              key={i}
              item={item}
              onAsk={i === latestAnswer ? ask : undefined}
              streaming={busy && i === items.length - 1}
            />
          ))}
          {resumable && !busy && (
            <Button
              icon="repeat"
              variant="secondary"
              size="sm"
              className={s.resume}
              onClick={() => {
                stick.current = true;
                chat.resume();
              }}
              tooltip="Pick up where it stopped: finished steps are kept, only what was interrupted is redone"
            >
              Continue
            </Button>
          )}
          {busy && (
            <Step icon="spinner" className={s.progress}>
              <span className={s.working}>Working…</span>
            </Step>
          )}
        </div>
      </div>
      {status && !status.ok && (
        <Alert severity="info" title="Clarity needs the Grafana LLM app" className={s.notConfigured}>
          {/* own line: the LLM app's errors come without a full stop */}
          <div>{status.error}</div>
          An admin can install it and choose a model provider (OpenAI, Anthropic, or an OpenAI-compatible API such as
          Ollama or OpenRouter) on the{' '}
          <a className={s.link} href={`plugins/${LLM_APP}`}>
            LLM app page
          </a>
          .
        </Alert>
      )}
      <form
        className={s.composer}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          className={s.textarea}
          value={draft}
          rows={2}
          aria-label="Question"
          placeholder="Ask a question about your services"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            // not while an IME is composing (Enter picks the candidate); Safari reports that as keyCode 229
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={!configured}
        />
        <div className={s.composerBar}>
          <span className={s.hint}>Enter to send, Shift+Enter for a new line</span>
          {busy ? (
            <Button size="sm" icon="square-shape" variant="secondary" onClick={chat.stop}>
              Stop
            </Button>
          ) : (
            <Button size="sm" icon="arrow-up" type="submit" disabled={!draft.trim() || !configured}>
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
};

/**
 * One entry of the conversation. `onAsk` is set only for the newest answer, which shows its follow-ups;
 * `streaming`: the entry is still being written.
 */
const ChatItemView = ({
  item,
  onAsk,
  streaming,
}: {
  item: Item;
  onAsk?: (question: string) => void;
  streaming?: boolean;
}) => {
  const s = useStyles2(getStyles);
  switch (item.kind) {
    case 'user':
      return <div className={s.user}>{item.text}</div>;
    case 'assistant': {
      const { body, followUps } = splitFollowUps(item.text);
      return (
        <>
          <div
            className={cx('markdown-html', s.assistant, item.interrupted && s.interrupted, streaming && s.streaming)}
            dangerouslySetInnerHTML={{ __html: safeHtml(body) }}
          />
          {onAsk && !item.interrupted && followUps.length > 0 && (
            <div className={s.followUps}>
              {followUps.map((q) => (
                <Button
                  key={q}
                  size="sm"
                  variant="secondary"
                  fill="outline"
                  icon="corner-down-right-alt"
                  onClick={() => onAsk(q)}
                >
                  {q}
                </Button>
              ))}
            </div>
          )}
        </>
      );
    }
    case 'progress':
      return <Step className={cx(s.progress, item.interrupted && s.interrupted)}>{item.text}</Step>;
    case 'usage':
      return <div className={s.usage}>{item.text}</div>;
    case 'tool':
      return <ToolCard item={item} />;
    case 'error':
      return (
        <Alert severity={item.info ? 'info' : 'error'} title="" className={s.alert}>
          {item.text}
        </Alert>
      );
  }
};

// memo: items are immutable, so streaming text only re-renders the last item, not every panel above it
const ChatItem = memo(ChatItemView);

const getStyles = (theme: GrafanaTheme2) => {
  const motion = theme.transitions.handleMotion('no-preference');
  const stagger = (delays: number[]) =>
    Object.fromEntries(delays.map((ms, i) => [`& > :nth-child(${i + 1})`, { animationDelay: `${ms}ms` }]));
  return {
    root: css({ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }),
    messages: css({ flex: 1, overflowY: 'auto', padding: theme.spacing(0, 2), minHeight: 0 }),
    // at least as tall as the scroller, so the welcome can sit in its middle
    content: css({
      minHeight: '100%',
      display: 'flex',
      flexDirection: 'column',
      paddingBottom: theme.spacing(1),
      [motion]: { '& > *': { animation: `${enter} 250ms ${theme.transitions.easing.easeOut} backwards` } },
    }),
    welcome: css({
      margin: 'auto', // centred both ways in the empty conversation
      padding: theme.spacing(4, 0),
      width: '100%',
      maxWidth: 560,
      display: 'flex',
      flexDirection: 'column',
      gap: theme.spacing(0.5),
      textAlign: 'center',
      [motion]: {
        '& > *': { animation: `${enter} 400ms ${theme.transitions.easing.easeOut} backwards` },
        ...stagger([0, 70, 160, 220, 280, 340]),
      },
    }),
    welcomeTitle: css({ margin: 0 }),
    welcomeText: css({ color: theme.colors.text.secondary, margin: theme.spacing(0, 0, 1.5) }),
    suggestion: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1.5),
      padding: theme.spacing(1, 1.5),
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      background: 'none',
      color: theme.colors.text.primary,
      textAlign: 'left',
      transition: theme.transitions.create(['background-color', 'border-color', 'box-shadow', 'transform'], {
        duration: theme.transitions.duration.shorter,
      }),
      svg: { flex: 'none', color: theme.colors.text.secondary, transition: theme.transitions.create('color') },
      '&:hover:enabled': {
        background: theme.colors.action.hover,
        borderColor: theme.colors.border.medium,
        boxShadow: theme.shadows.z1,
        svg: { color: theme.colors.primary.text },
      },
      [motion]: { '&:hover:enabled': { transform: 'translateY(-1px)' }, '&:active:enabled': { transform: 'none' } },
      '&:focus-visible': { outline: `2px solid ${theme.colors.primary.main}`, outlineOffset: 1 },
      '&:disabled': { color: theme.colors.text.disabled, cursor: 'not-allowed' },
    }),
    // each question opens a turn; the steps it took and the answer follow under it
    user: css({
      fontSize: theme.typography.h5.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
      lineHeight: theme.typography.h5.lineHeight,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      padding: theme.spacing(3, 0, 1.5),
      '&:not(:first-child)': { marginTop: theme.spacing(1), borderTop: `1px solid ${theme.colors.border.weak}` },
    }),
    assistant: css({
      margin: theme.spacing(0.5, 0, 1),
      transition: theme.transitions.create('opacity'),
      maxWidth: '80ch', // prose line length on the wide page; panels above stay full width
      overflowX: 'auto',
      'p:last-child': { marginBottom: 0 },
    }),
    interrupted: css({ opacity: 0.6, '&::after': { content: '" (interrupted)"', fontStyle: 'italic' } }),
    // a caret after the text written so far
    streaming: css({
      '& > :last-child::after': {
        content: '""',
        display: 'inline-block',
        width: '0.45em',
        height: '1em',
        marginLeft: 2,
        verticalAlign: 'text-bottom',
        borderRadius: 1,
        background: theme.colors.text.secondary,
        [motion]: { animation: `${blink} 1s steps(1) infinite` },
      },
    }),
    resume: css({ alignSelf: 'flex-start', marginBottom: theme.spacing(1) }),
    followUps: css({
      display: 'flex',
      flexWrap: 'wrap',
      gap: theme.spacing(1),
      margin: theme.spacing(1, 0),
      [motion]: {
        '& > *': { animation: `${enter} 300ms ${theme.transitions.easing.easeOut} backwards` },
        ...stagger([0, 80, 160]),
      },
    }),
    progress: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      fontStyle: 'italic',
      whiteSpace: 'pre-wrap',
      transition: theme.transitions.create('opacity'),
    }),
    // a band of the logo's spectrum sweeps across the text
    working: css({
      [motion]: {
        color: 'transparent',
        background: `linear-gradient(90deg, ${theme.colors.text.secondary} 42%, #F2495C 47%, #FADE2A 50%, #5794F2 53%, ${theme.colors.text.secondary} 58%) 0 0 / 300% 100%`,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        animation: `${shimmer} 2.2s linear infinite`,
      },
    }),
    usage: css({
      color: theme.colors.text.disabled,
      fontSize: theme.typography.bodySmall.fontSize,
      margin: theme.spacing(0.5, 0, 2),
    }),
    alert: css({ margin: theme.spacing(1, 0) }),
    notConfigured: css({ flex: 'none', margin: theme.spacing(0, 2, 1) }), // Grafana's Alert has flexGrow: 1
    link: css({ textDecoration: 'underline' }),
    // one surface for typing and sending, with Grafana's focus ring around all of it
    composer: css({
      margin: theme.spacing(1, 2, 2),
      border: `1px solid ${theme.components.input.borderColor}`,
      borderRadius: theme.shape.radius.default,
      background: theme.components.input.background,
      transition: theme.transitions.create(['border-color', 'box-shadow'], {
        duration: theme.transitions.duration.shorter,
      }),
      '&:hover': { borderColor: theme.components.input.borderHover },
      '&:focus-within': {
        outline: '2px dotted transparent',
        boxShadow: `0 0 0 2px ${theme.colors.background.canvas}, 0 0 0 4px ${theme.colors.primary.main}`,
      },
    }),
    textarea: css({
      display: 'block',
      width: '100%',
      padding: theme.spacing(1, 1.5, 0),
      border: 'none',
      outline: 'none',
      resize: 'none',
      background: 'transparent',
      color: theme.components.input.text,
      font: 'inherit',
      fieldSizing: 'content', // grows with the question where supported, rows={2} elsewhere
      minHeight: theme.spacing(6),
      maxHeight: '40vh',
      '&::placeholder': { color: theme.colors.text.disabled },
      '&:disabled': { cursor: 'not-allowed' },
    }),
    composerBar: css({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing(1),
      padding: theme.spacing(0.5, 0.5, 0.5, 1.5),
    }),
    hint: css({ color: theme.colors.text.disabled, fontSize: theme.typography.bodySmall.fontSize }),
  };
};
