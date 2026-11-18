import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SystemDashboard } from '@triageai/contracts';

import { AgentShareBar, TrajectoryQualityTile } from './DashboardPage';

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

describe('TrajectoryQualityTile (phase 18.T24)', () => {
  it('shows average path efficiency, wasted steps and the common failing step', () => {
    render(
      <TrajectoryQualityTile
        trajectory={{
          runs: 4,
          averagePathEfficiency: 0.875,
          stepPassRate: 0.75,
          wastedSteps: 3,
          redundantSteps: 2,
          mostCommonFailingStep: 'answer',
        }}
      />,
    );
    expect(screen.getByText('88% path efficiency')).toBeInTheDocument();
    expect(screen.getByText('Wasted steps')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('answer')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('renders an honest empty state without a golden path', () => {
    render(
      <TrajectoryQualityTile
        trajectory={{
          runs: 0,
          averagePathEfficiency: null,
          stepPassRate: null,
          wastedSteps: 0,
          redundantSteps: 0,
          mostCommonFailingStep: null,
        }}
      />,
    );
    expect(screen.getByText('No trajectories yet')).toBeInTheDocument();
  });
});
