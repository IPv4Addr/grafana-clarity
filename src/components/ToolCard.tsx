import React, { ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { css, cx, keyframes } from '@emotion/css';
import { EventBusSrv, GrafanaTheme2, IconName, LoadingState, PanelData } from '@grafana/data';
import { PanelRenderer } from '@grafana/runtime';
import { Icon, LinkButton, PanelChrome, PanelContextProvider, useStyles2 } from '@grafana/ui';
import { ToolView, describeCall } from '../agent/tools';
import type { Item } from '../agent/store';

// Stable identities: PanelRenderer re-applies field overrides whenever options/fieldConfig objects change.
const FIELD_CONFIG = { defaults: {}, overrides: [] };
const OPTIONS: Record<ToolView['panel'], object> = {
  timeseries: {
    legend: { showLegend: true, displayMode: 'list', placement: 'bottom' },
    tooltip: { mode: 'multi', sort: 'desc' },
  },
  bargauge: {
    orientation: 'horizontal',
    displayMode: 'basic',
    namePlacement: 'top', // long label sets would be cut off next to the bar on a narrow page
    reduceOptions: { values: false, calcs: ['lastNotNull'] },
  },
  logs: {
    showTime: true,
    wrapLogMessage: true,
    enableLogDetails: true,
    sortOrder: 'Descending',
    dedupStrategy: 'none',
  },
  table: { showHeader: true, cellHeight: 'sm' },
  traces: {},
};

type ToolItem = Extract<Item, { kind: 'tool' }>;

// A step's marker pops when it changes (spinner to check), a result panel fades in once its data is there.
const pop = keyframes({ from: { opacity: 0, transform: 'scale(0.4)' }, '60%': { transform: 'scale(1.15)' } });
const fadeIn = keyframes({ from: { opacity: 0 } });

/** A tool call as a step: what was queried, the result as a Grafana panel, and the text the model got. */
export const ToolCard = ({ item }: { item: ToolItem }) => {
  const s = useStyles2(getStyles);
  const { title, code } = describeCall(item.name, item.input);
  const view = item.result?.view;
  return (
    <Step icon={item.error ? 'exclamation-triangle' : item.result ? 'check' : 'spinner'} error={Boolean(item.error)}>
      <div className={s.card}>
        <div className={s.header}>
          <span className={s.title}>{title}</span>
          {view?.explore && (
            <LinkButton
              href={view.explore}
              size="sm"
              variant="secondary"
              fill="text"
              icon="compass"
              tooltip="Open in Explore"
            >
              Explore
            </LinkButton>
          )}
        </div>
        {code && <pre className={s.code}>{code}</pre>}
        {item.error && (
          <div className={s.error} role="alert">
            {item.error}
          </div>
        )}
        {view && <Panel view={view} title={title} />}
        {item.result && (
          <details className={s.details}>
            <summary>What the assistant saw</summary>
            <pre className={s.code}>{item.result.forModel}</pre>
          </details>
        )}
      </div>
    </Step>
  );
};

/**
 * One stop on the investigation trail: a marker on a vertical line, so the queries and notes that led to an
 * answer read as one sequence. Without an icon the marker is a dot (the model's own notes).
 */
export const Step = ({
  icon,
  error,
  className,
  children,
}: {
  icon?: IconName;
  error?: boolean;
  className?: string;
  children: ReactNode;
}) => {
  const s = useStyles2(getStyles);
  return (
    <div className={s.step}>
      {/* keyed by icon: a new icon is a new element, so it pops in */}
      <span key={icon ?? 'dot'} className={cx(s.marker, error && s.errorIcon)}>
        {icon ? <Icon name={icon} size="sm" /> : <span className={s.dot} />}
      </span>
      <div className={cx(s.stepBody, className)}>{children}</div>
    </div>
  );
};

/** Renders a tool result with Grafana's own panel plugin, sized to the width it gets. */
const Panel = ({ view, title }: { view: ToolView; title: string }) => {
  const s = useStyles2(getStyles);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);
  const data = useMemo<PanelData>(
    () => ({ state: LoadingState.Done, series: view.frames, timeRange: view.timeRange }),
    [view]
  );
  // own event bus: hover and tooltip events stay within this panel
  const panelContext = useMemo(() => ({ eventsScope: 'clarity', eventBus: new EventBusSrv() }), []);
  return (
    <div ref={ref} className={s.panel}>
      {width > 0 && (
        <PanelChrome width={width} height={view.height} hoverHeader>
          {(w, h) => (
            <PanelContextProvider value={panelContext}>
              <PanelRenderer
                pluginId={view.panel}
                title={title}
                width={w}
                height={h}
                data={data}
                options={OPTIONS[view.panel]}
                fieldConfig={FIELD_CONFIG}
              />
            </PanelContextProvider>
          )}
        </PanelChrome>
      )}
    </div>
  );
};

const MARKER = 20; // px, one line of small text: markers sit level with a step's first line

const getStyles = (theme: GrafanaTheme2) => {
  const motion = theme.transitions.handleMotion('no-preference');
  return {
    step: css({
      position: 'relative',
      display: 'grid',
      gridTemplateColumns: `${MARKER}px minmax(0, 1fr)`,
      columnGap: theme.spacing(1),
      paddingBottom: theme.spacing(1.5),
      // the trail runs from under this marker to the next one; after the last step it leads into the answer
      '&::before': {
        content: '""',
        position: 'absolute',
        left: MARKER / 2,
        top: MARKER + 2,
        bottom: 0,
        borderLeft: `1px solid ${theme.colors.border.medium}`,
      },
    }),
    panel: css({ [motion]: { animation: `${fadeIn} 400ms ${theme.transitions.easing.easeOut} backwards` } }),
    marker: css({
      [motion]: { animation: `${pop} 300ms ${theme.transitions.easing.easeOut} backwards` },
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: MARKER,
      color: theme.colors.text.secondary,
    }),
    dot: css({ width: 7, height: 7, borderRadius: '50%', background: theme.colors.border.strong }),
    stepBody: css({
      minWidth: 0,
      minHeight: MARKER,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
    }),
    card: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(0.75) }),
    header: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      minHeight: MARKER,
      color: theme.colors.text.secondary,
    }),
    title: css({
      flex: 1,
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
    }),
    code: css({
      margin: 0,
      padding: theme.spacing(0.5, 1),
      fontSize: theme.typography.bodySmall.fontSize,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: 240,
      overflow: 'auto',
    }),
    error: css({ color: theme.colors.error.text, fontSize: theme.typography.bodySmall.fontSize }),
    errorIcon: css({ color: theme.colors.error.text }),
    details: css({
      fontSize: theme.typography.bodySmall.fontSize,
      color: theme.colors.text.secondary,
      summary: { cursor: 'pointer', width: 'fit-content' },
    }),
  };
};
