import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App';

describe('App', () => {
  it('renders the TriageAI heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'TriageAI' })).toBeInTheDocument();
  });
});
