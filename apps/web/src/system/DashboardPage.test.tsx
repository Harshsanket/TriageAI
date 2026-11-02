import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SystemDashboard } from '@triageai/contracts';

import { AgentShareBar } from './DashboardPage';

const agents: SystemDashboard['agents'] = [
  {
    id: 'a1',
    displayName: 'Voyager',
    color: '#3b6fd4',
    running: 1,
    runs: 3,
    tokens: 120,
    cost: 0.01,
    succeeded: 2,
    failed: 1,
    series: [],
  },
  {
    id: 'a2',
    displayName: 'Pioneer',
    color: '#d9730d',
    running: 0,
    runs: 1,
    tokens: 40,
    cost: 0.004,
    succeeded: 1,
    failed: 0,
    series: [],
  },
];

describe('AgentShareBar (phase 20.8)', () => {
  it('renders one proportional series per active agent with an accessible summary', () => {
    const { container } = render(<AgentShareBar agents={agents} />);
    const bar = screen.getByRole('img', { name: /Voyager: 3 runs, Pioneer: 1 runs/i });
    expect(bar).toBeInTheDocument();
    const segments = container.querySelectorAll('.dashboard__share-bar span');
    expect(segments).toHaveLength(2);
    expect((segments[0] as HTMLElement).style.width).toBe('75%');
    expect((segments[1] as HTMLElement).style.width).toBe('25%');
    expect(screen.getByText('Runs by agent (last 24 h)')).toBeInTheDocument();
  });

  it('renders nothing when no agent has runs', () => {
    const { container } = render(<AgentShareBar agents={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
