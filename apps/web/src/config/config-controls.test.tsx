import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KernelControlsCard } from './ConfigPage';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('kernel controls card (18.T8)', () => {
  it('renders rows from the catalog metadata, including applies mode and danger', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          profile: 'core',
          retention: { enabled: false, runDays: 30 },
          controls: {
            fields: ['profile', 'retention'],
            catalog: {
              profile: {
                section: 'setup',
                label: 'Profile',
                help: 'core, support or assistant; presets decide default modules.',
                default: 'core',
                applies: 'restart',
              },
              retention: {
                section: 'data',
                label: 'Retention',
                help: 'Delete runs and audit rows by age.',
                default: { enabled: false },
                applies: 'immediately',
                danger: true,
              },
            },
          },
        }),
      ),
    );
    render(<KernelControlsCard />);
    expect(await screen.findByText('Profile')).toBeInTheDocument();
    expect(screen.getByText('Retention')).toBeInTheDocument();
    expect(
      screen.getByText('core, support or assistant; presets decide default modules.'),
    ).toBeInTheDocument();
    expect(screen.getByText('restart')).toBeInTheDocument();
    expect(screen.getByText('immediately · danger')).toBeInTheDocument();
    expect(screen.getByText('{"enabled":false,"runDays":30}')).toBeInTheDocument();
  });

  it('degrades to a hint when the catalog is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );
    render(<KernelControlsCard />);
    expect(await screen.findByText('Control metadata unavailable.')).toBeInTheDocument();
  });
});
