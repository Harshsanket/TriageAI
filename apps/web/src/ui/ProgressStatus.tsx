import { useEffect, useState } from 'react';

import { Notice } from './index';

export type ProgressState =
  | 'understanding'
  | 'searching'
  | 'using_tool'
  | 'thinking'
  | 'checking'
  | 'waiting_for_approval'
  | 'writing';

const PLAYFUL: Record<ProgressState, string[]> = {
  understanding: ['Reading the question…', 'Working out what you mean…'],
  searching: ['Navigating the docs…', 'Rummaging through the knowledge base…'],
  using_tool: ['Poking the tools…', 'Asking the knowledge base…'],
  thinking: ['Cooking the answer…', 'Hustling hard for answers…'],
  checking: ['Double-checking the sources…', 'Making sure it adds up…'],
  waiting_for_approval: ['Waiting for a person…', 'Holding for approval…'],
  writing: ['Plating it up…', 'Writing it down…'],
};

const NEUTRAL: Record<ProgressState, string> = {
  understanding: 'Understanding the request…',
  searching: 'Searching…',
  using_tool: 'Using a tool…',
  thinking: 'Thinking…',
  checking: 'Checking the answer…',
  waiting_for_approval: 'Waiting for approval…',
  writing: 'Writing the answer…',
};

export function progressLabel(
  state: ProgressState,
  tone: 'playful' | 'neutral' | 'off' = 'playful',
  serious = false,
): string | null {
  if (tone === 'off') return null;
  if (tone === 'neutral' || serious) return NEUTRAL[state];
  const labels = PLAYFUL[state];
  return labels[Math.floor(Math.random() * labels.length)] ?? NEUTRAL[state];
}

/** Polite, non-blocking progress with a "still working" note after 10 s. */
export function ProgressStatus({
  state,
  tone = 'playful',
  serious = false,
  step,
}: {
  state: ProgressState;
  tone?: 'playful' | 'neutral' | 'off';
  serious?: boolean;
  step?: { index: number; maxSteps: number };
}) {
  const [label, setLabel] = useState(() => progressLabel(state, tone, serious));
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setLabel(progressLabel(state, tone, serious));
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, [state, tone, serious]);

  if (!label) return null;
  return (
    <div aria-live="polite">
      <Notice tone="info">
        <span>{label}</span>
        {slow ? (
          <span className="ui-notice__meta">
            Still working
            {step ? ` — step ${step.index} of up to ${step.maxSteps}` : ''}…
          </span>
        ) : null}
      </Notice>
    </div>
  );
}
