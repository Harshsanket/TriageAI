import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { Markdown } from './Markdown.js';

describe('safe Markdown rendering (18.T28)', () => {
  it('never renders raw HTML or remote images', () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror=alert(1)>\n![x](https://evil.test/a.png)'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('[image removed]');
  });

  it('labels link domains and refuses javascript URLs', () => {
    const { container } = render(
      <Markdown text={'[docs](https://example.com/a) and [bad](javascript:alert(1))'} />,
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a');
    expect(link?.textContent).toContain('example.com');
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('renders inline code and bold as text, not HTML', () => {
    const { container } = render(<Markdown text={'Use `callModel` and **never** eval <b>x</b>'} />);
    expect(container.querySelector('code')?.textContent).toBe('callModel');
    expect(container.querySelector('strong')?.textContent).toBe('never');
    expect(container.querySelector('b')).toBeNull();
  });
});
