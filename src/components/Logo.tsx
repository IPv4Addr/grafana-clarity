import React from 'react';
import { css, keyframes } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';

// The prism of img/logo.svg, drawn inline so its light can move: the beam and the rays draw in when it appears,
// and a wave runs through the spectrum while Clarity is working.
const RAYS = [
  { x2: 61, y2: 18, color: '#F2495C' },
  { x2: 62, y2: 31, color: '#FADE2A' },
  { x2: 61, y2: 44, color: '#5794F2' },
];
const LENGTH = 24; // a little more than the longest line, so a dash of this length hides or shows a whole line

const draw = keyframes({ from: { strokeDashoffset: LENGTH } });
const pulse = keyframes({ '50%': { opacity: 0.25 } });

/** The Clarity prism. `busy`: the rays pulse, red to blue, while an answer is being worked on. */
export const Logo = ({ size, busy }: { size: number; busy?: boolean }) => {
  const s = useStyles2(getStyles);
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden className={s.logo}>
      <line className={s.line} x1="3" y1="38" x2="22.8" y2="31" stroke="#8B95A5" strokeWidth="3.5" />
      {RAYS.map(({ x2, y2, color }) => (
        <g key={color} className={busy ? s.pulse : undefined}>
          <line className={s.line} x1="41.2" y1="31" x2={x2} y2={y2} stroke={color} strokeWidth="3.5" />
        </g>
      ))}
      <path d="M32 11 L50 50 L14 50 Z" fill="none" stroke="#B4C0D3" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  logo: css({
    flex: 'none',
    [theme.transitions.handleMotion('no-preference')]: {
      // the beam first, then the rays one after the other, as the light passes through the prism
      '& g:nth-of-type(1) line': { animationDelay: '250ms' },
      '& g:nth-of-type(2) line': { animationDelay: '340ms' },
      '& g:nth-of-type(3) line': { animationDelay: '430ms' },
      '& g:nth-of-type(2)': { animationDelay: '150ms' },
      '& g:nth-of-type(3)': { animationDelay: '300ms' },
    },
  }),
  line: css({
    strokeDasharray: LENGTH,
    [theme.transitions.handleMotion('no-preference')]: {
      animation: `${draw} 450ms ${theme.transitions.easing.easeOut} backwards`,
    },
  }),
  pulse: css({
    [theme.transitions.handleMotion('no-preference')]: {
      animation: `${pulse} 1.2s ${theme.transitions.easing.easeInOut} infinite`,
    },
  }),
});
